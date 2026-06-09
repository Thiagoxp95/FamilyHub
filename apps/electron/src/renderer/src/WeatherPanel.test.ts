import { describe, expect, it } from "vitest";
import { weatherEmoji } from "./WeatherPanel";

describe("weatherEmoji", () => {
  it("uses day and night icons for clear weather", () => {
    expect(weatherEmoji("clear", true)).toBe("☀️");
    expect(weatherEmoji("clear", false)).toBe("🌙");
  });

  it("maps weather categories to display-only icons", () => {
    expect(weatherEmoji("partly-cloudy", true)).toBe("🌤️");
    expect(weatherEmoji("partly-cloudy", false)).toBe("🌙");
    expect(weatherEmoji("cloudy", true)).toBe("☁️");
    expect(weatherEmoji("fog", true)).toBe("🌫️");
    expect(weatherEmoji("drizzle", true)).toBe("🌦️");
    expect(weatherEmoji("rain", true)).toBe("🌧️");
    expect(weatherEmoji("snow", true)).toBe("❄️");
    expect(weatherEmoji("thunder", true)).toBe("⛈️");
  });
});
