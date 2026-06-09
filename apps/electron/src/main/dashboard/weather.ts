// Weather for the dashboard: locate the device by IP, then fetch current
// conditions from Open-Meteo (free, no key). WMO weather codes are mapped to a
// small set of animation-friendly categories.

export type WeatherCategory =
  | "clear"
  | "partly-cloudy"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "thunder";

export interface WeatherCondition {
  category: WeatherCategory;
  code: number;
  isDay: boolean;
  label: string;
}

// One day in the extended forecast. Temperatures are Celsius, wind mph, precip
// mm, chance/humidity percent. Nullable fields are omitted by Open-Meteo for
// some locations/days.
export interface WeatherDay {
  condition: WeatherCondition;
  date: string;
  highC: number;
  humidity: number | null;
  lowC: number;
  precipitationChance: number | null;
  precipitationMm: number | null;
  sunrise: string | null;
  sunset: string | null;
  uvIndex: number | null;
  windMph: number | null;
}

export interface WeatherSnapshot {
  apparentC: number;
  city: string | null;
  condition: WeatherCondition;
  forecast: WeatherDay[];
  highC: number;
  humidity: number | null;
  lowC: number;
  precipitationMm: number | null;
  temperatureC: number;
  updatedAt: string;
  uvIndex: number | null;
  windMph: number | null;
}

interface WeatherLocation {
  city: string;
  latitude: number;
  longitude: number;
}

// The kitchen display lives in La Prairie, QC, so the weather is pinned there
// rather than IP-geolocated (which resolved to Montreal). Overridable via env.
function resolveLocation(): WeatherLocation {
  const latitude = Number(process.env.FAMILYHUB_WEATHER_LAT);
  const longitude = Number(process.env.FAMILYHUB_WEATHER_LON);

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return {
      city: process.env.FAMILYHUB_WEATHER_CITY?.trim() || "La Prairie",
      latitude,
      longitude,
    };
  }

  return { city: "La Prairie", latitude: 45.4167, longitude: -73.4958 };
}

export function mapWeatherCode(code: number, isDay: boolean): WeatherCondition {
  const build = (category: WeatherCategory, label: string): WeatherCondition => ({
    category,
    code,
    isDay,
    label,
  });

  if (code === 0) {
    return build("clear", isDay ? "Clear" : "Clear night");
  }

  if (code === 1 || code === 2) {
    return build("partly-cloudy", "Partly cloudy");
  }

  if (code === 3) {
    return build("cloudy", "Overcast");
  }

  if (code === 45 || code === 48) {
    return build("fog", "Fog");
  }

  if (code >= 51 && code <= 57) {
    return build("drizzle", "Drizzle");
  }

  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) {
    return build("rain", "Rain");
  }

  if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
    return build("snow", "Snow");
  }

  if (code >= 95) {
    return build("thunder", "Thunderstorm");
  }

  return build("cloudy", "Cloudy");
}

// Number of days of daily forecast to request and surface in the expanded view.
const forecastDays = 14;

function roundOrNull(value: number | undefined): number | null {
  return typeof value === "number" ? Math.round(value) : null;
}

function stringOrNull(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

interface DailyArrays {
  precipitation_probability_max?: number[];
  precipitation_sum?: number[];
  relative_humidity_2m_mean?: number[];
  sunrise?: string[];
  sunset?: string[];
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  time?: string[];
  uv_index_max?: number[];
  weather_code?: number[];
  wind_speed_10m_max?: number[];
}

// Transpose Open-Meteo's column-per-variable daily arrays into one record per
// day. Daily entries are always daytime, so condition icons use the day variant.
export function buildForecast(daily: DailyArrays): WeatherDay[] {
  const dates = daily.time ?? [];
  return dates.map((date, index) => {
    const high = daily.temperature_2m_max?.[index];
    const low = daily.temperature_2m_min?.[index];
    return {
      condition: mapWeatherCode(daily.weather_code?.[index] ?? 3, true),
      date,
      highC: Math.round(high ?? low ?? 0),
      humidity: roundOrNull(daily.relative_humidity_2m_mean?.[index]),
      lowC: Math.round(low ?? high ?? 0),
      precipitationChance: roundOrNull(
        daily.precipitation_probability_max?.[index],
      ),
      precipitationMm:
        typeof daily.precipitation_sum?.[index] === "number"
          ? Math.round(daily.precipitation_sum[index] * 10) / 10
          : null,
      sunrise: stringOrNull(daily.sunrise?.[index]),
      sunset: stringOrNull(daily.sunset?.[index]),
      uvIndex: roundOrNull(daily.uv_index_max?.[index]),
      windMph: roundOrNull(daily.wind_speed_10m_max?.[index]),
    };
  });
}

export async function loadWeather(): Promise<WeatherSnapshot> {
  const location = resolveLocation();
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m,precipitation,uv_index",
  );
  url.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "relative_humidity_2m_mean",
      "wind_speed_10m_max",
      "uv_index_max",
      "sunrise",
      "sunset",
    ].join(","),
  );
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", String(forecastDays));

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open-Meteo request failed (${response.status}).`);
  }

  const data = (await response.json()) as {
    current?: {
      apparent_temperature?: number;
      is_day?: number;
      precipitation?: number;
      relative_humidity_2m?: number;
      temperature_2m?: number;
      uv_index?: number;
      weather_code?: number;
      wind_speed_10m?: number;
    };
    daily?: DailyArrays;
  };

  const current = data.current ?? {};
  const daily = data.daily ?? {};
  const forecast = buildForecast(daily);
  const today = forecast[0];
  const temperature = current.temperature_2m ?? 0;

  return {
    apparentC: Math.round(current.apparent_temperature ?? temperature),
    city: location.city,
    condition: mapWeatherCode(current.weather_code ?? 3, current.is_day !== 0),
    forecast,
    highC: today?.highC ?? Math.round(temperature),
    humidity: roundOrNull(current.relative_humidity_2m),
    lowC: today?.lowC ?? Math.round(temperature),
    precipitationMm:
      typeof current.precipitation === "number"
        ? Math.round(current.precipitation * 10) / 10
        : null,
    temperatureC: Math.round(temperature),
    updatedAt: new Date().toISOString(),
    uvIndex: roundOrNull(current.uv_index),
    windMph: roundOrNull(current.wind_speed_10m),
  };
}
