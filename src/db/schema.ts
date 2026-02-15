import {
  datetime,
  index,
  int,
  mysqlTable,
  text,
  varchar,
} from "drizzle-orm/mysql-core";

// Competitions table
export const competitions = mysqlTable("competitions", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  slug: varchar({ length: 255 }).notNull().unique(),
  name: varchar({ length: 255 }).notNull(),
  settings: text(),
  createdAt: datetime().notNull(),
  updatedAt: datetime().notNull(),
});

// Competition registrations table
export const competitionRegistrations = mysqlTable(
  "competition_registrations",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    eventId: varchar({ length: 255 }).notNull(),
    userId: varchar({ length: 255 }).notNull(),
    divisionId: varchar({ length: 255 }),
    registeredAt: datetime().notNull(),
    metadata: text(),
    createdAt: datetime().notNull(),
    updatedAt: datetime().notNull(),
  },
  (table) => [
    index("competition_registrations_event_idx").on(table.eventId),
    index("competition_registrations_user_idx").on(table.userId),
  ],
);

// Users table (minimal fields needed for leaderboard)
export const users = mysqlTable("users", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  firstName: varchar({ length: 255 }),
  lastName: varchar({ length: 255 }),
  email: varchar({ length: 255 }),
});

// Scaling levels (divisions) table
export const scalingLevels = mysqlTable("scaling_levels", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  scalingGroupId: varchar({ length: 255 }).notNull(),
  label: varchar({ length: 100 }).notNull(),
  position: int().notNull(),
  teamSize: int().default(1).notNull(),
});

// Programming tracks table
export const programmingTracks = mysqlTable("programming_tracks", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  name: varchar({ length: 255 }).notNull(),
  competitionId: varchar({ length: 255 }),
});

// Track workouts table
export const trackWorkouts = mysqlTable("track_workouts", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  trackId: varchar({ length: 255 }).notNull(),
  workoutId: varchar({ length: 255 }).notNull(),
  trackOrder: int().notNull(),
  pointsMultiplier: int().default(100),
  eventStatus: varchar({ length: 20 }).default("draft"),
});

// Workouts table (minimal fields needed)
export const workouts = mysqlTable("workouts", {
  id: varchar({ length: 255 }).primaryKey().notNull(),
  name: varchar({ length: 255 }).notNull(),
  scheme: varchar({ length: 255 }).notNull(),
  scoreType: varchar({ length: 255 }),
});

// Scores table
export const scores = mysqlTable(
  "scores",
  {
    id: varchar({ length: 255 }).primaryKey().notNull(),
    userId: varchar({ length: 255 }).notNull(),
    workoutId: varchar({ length: 255 }).notNull(),
    competitionEventId: varchar({ length: 255 }),
    scheme: varchar({ length: 255 }).notNull(),
    scoreValue: int(),
    status: varchar({ length: 255 }).notNull().default("scored"),
    statusOrder: int().notNull().default(0),
    sortKey: varchar({ length: 255 }),
    createdAt: datetime().notNull(),
    updatedAt: datetime().notNull(),
  },
  (table) => [
    index("idx_scores_competition").on(
      table.competitionEventId,
      table.statusOrder,
      table.sortKey,
    ),
  ],
);
