import { Context, Effect, Layer } from "effect";
import { eq, and, inArray, ne } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  competitions,
  competitionRegistrations,
  users,
  scalingLevels,
  programmingTracks,
  trackWorkouts,
  workouts,
  scores,
} from "../db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AthleteEventResult {
  eventId: string;
  eventName: string;
  points: number;
  rank: number;
}

export interface LeaderboardAthlete {
  rank: number;
  userId: string;
  name: string;
  affiliateName: string;
  events: AthleteEventResult[];
  totalPoints: number;
}

export interface DivisionLeaderboard {
  id: string;
  name: string;
  athletes: LeaderboardAthlete[];
}

export interface GymAthleteEvent {
  eventId: string;
  eventName: string;
  points: number;
  contributing: boolean;
}

export interface GymAthleteEntry {
  name: string;
  division: string;
  divisionRank: number;
  events: GymAthleteEvent[];
  contributingTotal: number;
}

export interface GymLeaderboard {
  name: string;
  rank: number;
  athleteCount: number;
  totalScore: number;
  athletes: GymAthleteEntry[];
}

export interface LeaderboardResponse {
  competition: { id: string; name: string };
  divisions: DivisionLeaderboard[];
  gyms: GymLeaderboard[];
}

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

export class LeaderboardService extends Context.Tag("LeaderboardService")<
  LeaderboardService,
  { getLeaderboard: (competitionId: string) => Effect.Effect<LeaderboardResponse, Error> }
>() {}

// ---------------------------------------------------------------------------
// Scoring: traditional points (100/95/90/85/80/76/73/71/70/69/68/...)
// ---------------------------------------------------------------------------

const TRADITIONAL_FIRST_PLACE = 100;
const TRADITIONAL_STEP = 5;

function calculateTraditionalPoints(place: number): number {
  if (place <= 0) return TRADITIONAL_FIRST_PLACE;
  const points = TRADITIONAL_FIRST_PLACE - (place - 1) * TRADITIONAL_STEP;
  return Math.max(0, points);
}

// ---------------------------------------------------------------------------
// Rank assignment (handles ties via sortKey)
// ---------------------------------------------------------------------------

interface ScoreEntry {
  userId: string;
  value: number | null;
  status: string;
  sortKey: string | null;
}

function assignRanks(sorted: ScoreEntry[]): Array<{ entry: ScoreEntry; rank: number }> {
  const result: Array<{ entry: ScoreEntry; rank: number }> = [];
  let currentRank = 1;
  let prevSortKey: string | null = null;
  let prevValue: number | null = null;

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];

    if (entry.sortKey && prevSortKey !== null) {
      if (entry.sortKey !== prevSortKey) currentRank = i + 1;
    } else if (prevValue !== null && entry.value !== prevValue) {
      currentRank = i + 1;
    }

    result.push({ entry, rank: currentRank });
    prevSortKey = entry.sortKey ?? null;
    prevValue = entry.value;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Parse affiliate name from registration metadata JSON
// ---------------------------------------------------------------------------

function parseAffiliateName(metadata: string | null): string {
  if (!metadata) return "Unaffiliated";
  try {
    const parsed = JSON.parse(metadata);
    // Check both possible locations per shaping doc
    if (parsed.affiliateName) return parsed.affiliateName;
    if (parsed.affiliates) {
      const first = Object.values(parsed.affiliates)[0];
      if (typeof first === "string") return first;
    }
    return "Unaffiliated";
  } catch {
    return "Unaffiliated";
  }
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export function makeLeaderboardService(db: Database) {
  const getLeaderboard = (competitionId: string): Effect.Effect<LeaderboardResponse, Error> =>
    Effect.tryPromise({
      try: async () => {
        // 1. Fetch competition
        const [comp] = await db
          .select({ id: competitions.id, name: competitions.name })
          .from(competitions)
          .where(eq(competitions.id, competitionId))
          .limit(1);

        if (!comp) throw new Error("Competition not found");

        // 2. Fetch programming track for this competition
        const [track] = await db
          .select({ id: programmingTracks.id })
          .from(programmingTracks)
          .where(eq(programmingTracks.competitionId, competitionId))
          .limit(1);

        if (!track) {
          return { competition: comp, divisions: [], gyms: [] };
        }

        // 3. Fetch published track workouts (events)
        const events = await db
          .select({
            id: trackWorkouts.id,
            trackOrder: trackWorkouts.trackOrder,
            pointsMultiplier: trackWorkouts.pointsMultiplier,
            workoutId: trackWorkouts.workoutId,
            workoutName: workouts.name,
            scheme: workouts.scheme,
          })
          .from(trackWorkouts)
          .innerJoin(workouts, eq(trackWorkouts.workoutId, workouts.id))
          .where(
            and(
              eq(trackWorkouts.trackId, track.id),
              eq(trackWorkouts.eventStatus, "published"),
            ),
          )
          .orderBy(trackWorkouts.trackOrder);

        if (events.length === 0) {
          return { competition: comp, divisions: [], gyms: [] };
        }

        // 4. Fetch registrations with user info and division
        const registrations = await db
          .select({
            regId: competitionRegistrations.id,
            userId: competitionRegistrations.userId,
            divisionId: competitionRegistrations.divisionId,
            metadata: competitionRegistrations.metadata,
            firstName: users.firstName,
            lastName: users.lastName,
            divisionLabel: scalingLevels.label,
          })
          .from(competitionRegistrations)
          .leftJoin(users, eq(competitionRegistrations.userId, users.id))
          .leftJoin(
            scalingLevels,
            eq(competitionRegistrations.divisionId, scalingLevels.id),
          )
          .where(
            and(
              eq(competitionRegistrations.eventId, competitionId),
              ne(competitionRegistrations.status, "REMOVED"),
            ),
          );

        if (registrations.length === 0) {
          return { competition: comp, divisions: [], gyms: [] };
        }

        // 5. Fetch all scores for these events
        const eventIds = events.map((e) => e.id);
        const userIds = registrations.map((r) => r.userId);

        const allScores = await db
          .select({
            userId: scores.userId,
            competitionEventId: scores.competitionEventId,
            scoreValue: scores.scoreValue,
            status: scores.status,
            sortKey: scores.sortKey,
          })
          .from(scores)
          .where(
            and(
              inArray(scores.competitionEventId, eventIds),
              inArray(scores.userId, userIds),
            ),
          );

        // 6. Build per-athlete data structure
        const athleteMap = new Map<
          string,
          {
            userId: string;
            name: string;
            affiliateName: string;
            divisionId: string;
            divisionLabel: string;
            events: AthleteEventResult[];
            totalPoints: number;
          }
        >();

        for (const reg of registrations) {
          const fullName =
            `${reg.firstName || ""} ${reg.lastName || ""}`.trim() || "Unknown";
          athleteMap.set(reg.userId, {
            userId: reg.userId,
            name: fullName,
            affiliateName: parseAffiliateName(reg.metadata),
            divisionId: reg.divisionId || "open",
            divisionLabel: reg.divisionLabel || "Open",
            events: [],
            totalPoints: 0,
          });
        }

        // 7. Compute per-event rankings and points (within each division)
        for (const event of events) {
          // Group scores by division
          const divisionScores = new Map<string, ScoreEntry[]>();

          for (const score of allScores) {
            if (score.competitionEventId !== event.id) continue;
            const athlete = athleteMap.get(score.userId);
            if (!athlete) continue;

            const divId = athlete.divisionId;
            const existing = divisionScores.get(divId) || [];
            existing.push({
              userId: score.userId,
              value: score.scoreValue,
              status: score.status,
              sortKey: score.sortKey,
            });
            divisionScores.set(divId, existing);
          }

          const multiplier = (event.pointsMultiplier ?? 100) / 100;

          for (const [_divId, divScores] of divisionScores) {
            // Split active vs inactive
            const active = divScores.filter(
              (s) => s.status === "scored" || s.status === "cap",
            );
            const dnfScores = divScores.filter((s) => s.status === "dnf");
            // dns and withdrawn athletes get 0 points (withdrawn excluded from gym totals later)

            // Sort active by sortKey (lexicographic) or value
            active.sort((a, b) => {
              if (a.sortKey && b.sortKey) return a.sortKey.localeCompare(b.sortKey);
              return (a.value ?? 0) - (b.value ?? 0);
            });

            const ranked = assignRanks(active);
            const lastActiveRank =
              ranked.length > 0 ? ranked[ranked.length - 1].rank : 0;

            // Award points to active athletes
            for (const { entry, rank } of ranked) {
              const points = Math.round(
                calculateTraditionalPoints(rank) * multiplier,
              );
              const athlete = athleteMap.get(entry.userId);
              if (!athlete) continue;
              athlete.events.push({
                eventId: event.id,
                eventName: event.workoutName,
                points,
                rank,
              });
              athlete.totalPoints += points;
            }

            // DNF gets last_place points
            for (const entry of dnfScores) {
              const athlete = athleteMap.get(entry.userId);
              if (!athlete) continue;

              const rank = lastActiveRank + 1;
              const points = Math.round(
                calculateTraditionalPoints(rank) * multiplier,
              );

              athlete.events.push({
                eventId: event.id,
                eventName: event.workoutName,
                points,
                rank,
              });
              athlete.totalPoints += points;
            }
          }

          // Athletes with no score for this event get 0
          for (const [_userId, athlete] of athleteMap) {
            const hasEvent = athlete.events.some((e) => e.eventId === event.id);
            if (!hasEvent) {
              athlete.events.push({
                eventId: event.id,
                eventName: event.workoutName,
                points: 0,
                rank: 0,
              });
            }
          }
        }

        // 8. Build division leaderboards
        const divisionGroups = new Map<
          string,
          { id: string; name: string; athletes: LeaderboardAthlete[] }
        >();

        for (const athlete of athleteMap.values()) {
          let div = divisionGroups.get(athlete.divisionId);
          if (!div) {
            div = {
              id: athlete.divisionId,
              name: athlete.divisionLabel,
              athletes: [],
            };
            divisionGroups.set(athlete.divisionId, div);
          }
          div.athletes.push({
            rank: 0, // assigned below
            userId: athlete.userId,
            name: athlete.name,
            affiliateName: athlete.affiliateName,
            events: athlete.events,
            totalPoints: athlete.totalPoints,
          });
        }

        // Rank athletes within each division
        for (const div of divisionGroups.values()) {
          div.athletes.sort((a, b) => b.totalPoints - a.totalPoints);
          let rank = 1;
          for (let i = 0; i < div.athletes.length; i++) {
            if (
              i > 0 &&
              div.athletes[i].totalPoints < div.athletes[i - 1].totalPoints
            ) {
              rank = i + 1;
            }
            div.athletes[i].rank = rank;
          }
        }

        const divisions = Array.from(divisionGroups.values());

        // 9. Build gym leaderboard (V2)
        // Per event: top 6 men + top 6 women per gym contribute
        // Different athletes can contribute for different events
        const TOP_PER_DIVISION = 6;

        // Build division rank lookup (userId → rank in their division)
        const divisionRankMap = new Map<string, number>();
        for (const div of divisionGroups.values()) {
          for (const a of div.athletes) {
            divisionRankMap.set(a.userId, a.rank);
          }
        }

        // Group athletes by gym
        const gymAthleteIds = new Map<string, string[]>();
        for (const athlete of athleteMap.values()) {
          const gymName = athlete.affiliateName;
          const existing = gymAthleteIds.get(gymName) || [];
          existing.push(athlete.userId);
          gymAthleteIds.set(gymName, existing);
        }

        const gyms: GymLeaderboard[] = [];

        for (const [gymName, userIds] of gymAthleteIds) {
          // For each event, determine which athletes from this gym contribute
          // contributing[userId][eventId] = true
          const contributingMap = new Map<string, Set<string>>();
          let totalScore = 0;

          for (const event of events) {
            // Group this gym's athletes by division for this event
            const byDiv = new Map<string, Array<{ userId: string; points: number }>>();

            for (const uid of userIds) {
              const athlete = athleteMap.get(uid)!;
              const eventResult = athlete.events.find((e) => e.eventId === event.id);
              const points = eventResult?.points ?? 0;

              const div = athlete.divisionLabel;
              const arr = byDiv.get(div) || [];
              arr.push({ userId: uid, points });
              byDiv.set(div, arr);
            }

            // Pick top 6 per division for this event
            for (const [_div, divAthletes] of byDiv) {
              divAthletes.sort((a, b) => b.points - a.points);
              for (let i = 0; i < Math.min(TOP_PER_DIVISION, divAthletes.length); i++) {
                const uid = divAthletes[i].userId;
                totalScore += divAthletes[i].points;

                let eventSet = contributingMap.get(uid);
                if (!eventSet) {
                  eventSet = new Set();
                  contributingMap.set(uid, eventSet);
                }
                eventSet.add(event.id);
              }
            }
          }

          // Build athlete entries sorted by contributing total desc
          const athleteEntries: GymAthleteEntry[] = userIds.map((uid) => {
            const athlete = athleteMap.get(uid)!;
            const contribEvents = contributingMap.get(uid) || new Set<string>();

            let contributingTotal = 0;
            const gymEvents: GymAthleteEvent[] = events.map((event) => {
              const eventResult = athlete.events.find((e) => e.eventId === event.id);
              const points = eventResult?.points ?? 0;
              const isContributing = contribEvents.has(event.id);
              if (isContributing) contributingTotal += points;

              return {
                eventId: event.id,
                eventName: event.workoutName,
                points,
                contributing: isContributing,
              };
            });

            return {
              name: athlete.name,
              division: athlete.divisionLabel,
              divisionRank: divisionRankMap.get(uid) ?? 0,
              events: gymEvents,
              contributingTotal,
            };
          });

          athleteEntries.sort((a, b) => b.contributingTotal - a.contributingTotal);

          gyms.push({
            name: gymName,
            rank: 0,
            athleteCount: userIds.length,
            totalScore,
            athletes: athleteEntries,
          });
        }

        // Remove gyms with no athletes, then rank by totalScore descending
        const nonEmptyGyms = gyms.filter((g) => g.athleteCount > 0);
        nonEmptyGyms.sort((a, b) => b.totalScore - a.totalScore);
        let gymRank = 1;
        for (let i = 0; i < nonEmptyGyms.length; i++) {
          if (i > 0 && nonEmptyGyms[i].totalScore < nonEmptyGyms[i - 1].totalScore) {
            gymRank = i + 1;
          }
          nonEmptyGyms[i].rank = gymRank;
        }

        return { competition: comp, divisions, gyms: nonEmptyGyms };
      },
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    });

  return LeaderboardService.of({ getLeaderboard });
}

export function LeaderboardLive(db: Database) {
  return Layer.succeed(LeaderboardService, makeLeaderboardService(db));
}
