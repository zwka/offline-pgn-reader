import { describe, expect, it } from "vitest";

import { parseMobileStaticServerOptions } from "../src/mobile-static.js";

describe("mobile static server options", () => {
  it("uses the default port when none is configured", () => {
    expect(parseMobileStaticServerOptions({
      rawPort: undefined,
      defaultPort: 8431,
    })).toEqual({ port: 8431 });
  });

  it.each(["1", "65535"])("accepts valid boundary port %s", (rawPort) => {
    expect(parseMobileStaticServerOptions({
      rawPort,
      defaultPort: 8431,
    })).toEqual({ port: Number(rawPort) });
  });

  it.each(["0", "65536", "1.5", "not-a-port"])("rejects invalid port %s", (rawPort) => {
    expect(() => parseMobileStaticServerOptions({
      rawPort,
      defaultPort: 8431,
    })).toThrow("Mobile static server port must be an integer between 1 and 65535");
  });
});
