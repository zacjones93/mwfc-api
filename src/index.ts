import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { createDb, type Env } from "./db/client";
import { competitions } from "./db/schema";
import {
  LeaderboardService,
  LeaderboardLive,
} from "./services/leaderboard";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Unhandled error:", message, err);
      return Response.json({ error: message }, { status: 500 });
    }
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "*";

  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const match = url.pathname.match(/^\/leaderboard\/([^/]+)$/);
  if (!match || request.method !== "GET") {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: corsHeaders },
    );
  }

  const idOrSlug = decodeURIComponent(match[1]);
  const db = createDb(env);

  let competitionId = idOrSlug;
  if (!idOrSlug.startsWith("comp_")) {
    const [comp] = await db
      .select({ id: competitions.id })
      .from(competitions)
      .where(eq(competitions.slug, idOrSlug))
      .limit(1);

    if (!comp) {
      return Response.json(
        { error: "Competition not found" },
        { status: 404, headers: corsHeaders },
      );
    }
    competitionId = comp.id;
  }

  const program = Effect.gen(function* () {
    const service = yield* LeaderboardService;
    return yield* service.getLeaderboard(competitionId);
  }).pipe(Effect.provide(LeaderboardLive(db)));

  try {
    const result = await Effect.runPromise(program);
    return Response.json(result, {
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=60",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Leaderboard error:", message, err);
    const status = message === "Competition not found" ? 404 : 500;
    return Response.json(
      { error: message },
      { status, headers: corsHeaders },
    );
  }
}
