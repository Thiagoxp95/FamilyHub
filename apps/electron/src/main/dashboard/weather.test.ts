import { describe, expect, it } from "vitest";
import { buildForecast, mapWeatherCode } from "./weather";

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

describe("buildForecast", () => {
  it("transposes daily columns into one record per day", () => {
    const forecast = buildForecast({
      time: ["2026-06-07", "2026-06-08"],
      weather_code: [0, 61],
      temperature_2m_max: [20.4, 18.9],
      temperature_2m_min: [14.6, 12.1],
      precipitation_sum: [0, 4.25],
      precipitation_probability_max: [5, 80],
      relative_humidity_2m_mean: [62.3, 74.8],
      wind_speed_10m_max: [11.6, 14.2],
      uv_index_max: [7.1, 4.4],
      sunrise: ["2026-06-07T05:08", "2026-06-08T05:08"],
      sunset: ["2026-06-07T20:42", "2026-06-08T20:43"],
    });

    expect(forecast).toHaveLength(2);
    expect(forecast[0]).toMatchObject({
      date: "2026-06-07",
      condition: { category: "clear", isDay: true },
      highC: 20,
      lowC: 15,
      precipitationMm: 0,
      precipitationChance: 5,
      humidity: 62,
      windMph: 12,
      uvIndex: 7,
      sunrise: "2026-06-07T05:08",
      sunset: "2026-06-07T20:42",
    });
    expect(forecast[1]).toMatchObject({
      condition: { category: "rain" },
      precipitationMm: 4.3,
      precipitationChance: 80,
    });
  });

  it("returns null for metrics absent from the response", () => {
    const forecast = buildForecast({
      time: ["2026-06-07"],
      weather_code: [3],
      temperature_2m_max: [10],
      temperature_2m_min: [4],
    });

    expect(forecast[0]).toMatchObject({
      highC: 10,
      lowC: 4,
      precipitationMm: null,
      precipitationChance: null,
      humidity: null,
      windMph: null,
      uvIndex: null,
      sunrise: null,
      sunset: null,
    });
  });

  it("is empty when no days are returned", () => {
    expect(buildForecast({})).toEqual([]);
  });
});
