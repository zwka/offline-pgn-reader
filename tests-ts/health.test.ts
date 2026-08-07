import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import { ErrorResponseSchema, HealthResponseSchema } from "../src/wire.js";

const fixture = JSON.parse(
  readFileSync(resolve("tests/fixtures/wire_contract.json"), "utf8"),
) as {
  healthOk: Record<string, unknown>;
  notFound: Record<string, unknown>;
};

const servers = [] as ReturnType<typeof buildServer>[];
const testDirectories: string[] = [];

function testServer(options: Parameters<typeof buildServer>[0] = {}) {
  const directory = mkdtempSync(join(tmpdir(), "offline-pgn-reader-ts-"));
  testDirectories.push(directory);
  return buildServer({ dbPath: join(directory, "index.sqlite3"), ...options });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  testDirectories.splice(0).forEach((directory) => rmSync(directory, { force: true, recursive: true }));
});

describe("Node application public seams", () => {
  it("serves the existing browser shell", async () => {
    const server = testServer();
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("PGN Reader");
  });

  it("returns a TypeBox-valid health response using the shared fixture", async () => {
    const server = testServer();
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/health" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(Value.Check(HealthResponseSchema, body)).toBe(true);
    expect(body).toEqual(fixture.healthOk);
  });

  it("returns the shared error envelope for an unknown route", async () => {
    const server = testServer();
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/missing" });
    const body = response.json();

    expect(response.statusCode).toBe(404);
    expect(Value.Check(ErrorResponseSchema, body)).toBe(true);
    expect(body).toEqual(fixture.notFound);
  });

  it("reports a degraded health response when the database probe fails", async () => {
    const server = testServer({ databaseProbe: () => false });
    servers.push(server);

    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "degraded", version: "1.1.0", db: false });
  });
});
