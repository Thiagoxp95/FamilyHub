import { describe, expect, it } from "vitest";
import { mapWeatherCode } from "./weather";

describe("mapWeatherCode", () => {
  it("maps clear codes by day and night", () => {
    expect(mapWeatherCode(0, true)).toMatchObject({
      category: "clear",
      label: "Clear",
    });
    expect(mapWeatherCode(0, false)).toMatchObject({
      category: "clear",
      label: "Clear night",
    });
  });

  it("maps cloud, fog, and precipitation families", () => {
    expect(mapWeatherCode(2, true).category).toBe("partly-cloudy");
    expect(mapWeatherCode(3, true).category).toBe("cloudy");
    expect(mapWeatherCode(48, true).category).toBe("fog");
    expect(mapWeatherCode(53, true).category).toBe("drizzle");
    expect(mapWeatherCode(65, true).category).toBe("rain");
    expect(mapWeatherCode(81, true).category).toBe("rain");
    expect(mapWeatherCode(73, true).category).toBe("snow");
    expect(mapWeatherCode(86, true).category).toBe("snow");
    expect(mapWeatherCode(95, true).category).toBe("thunder");
  });

  it("carries the original code and day flag", () => {
    expect(mapWeatherCode(61, false)).toMatchObject({ code: 61, isDay: false });
  });
});
