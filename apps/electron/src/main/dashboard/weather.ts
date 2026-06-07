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

export interface WeatherSnapshot {
  apparentC: number;
  city: string | null;
  condition: WeatherCondition;
  highC: number;
  humidity: number | null;
  lowC: number;
  temperatureC: number;
  updatedAt: string;
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

export async function loadWeather(): Promise<WeatherSnapshot> {
  const location = resolveLocation();
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m",
  );
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Open-Meteo request failed (${response.status}).`);
  }

  const data = (await response.json()) as {
    current?: {
      apparent_temperature?: number;
      is_day?: number;
      relative_humidity_2m?: number;
      temperature_2m?: number;
      weather_code?: number;
      wind_speed_10m?: number;
    };
    daily?: {
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
    };
  };

  const current = data.current ?? {};
  const daily = data.daily ?? {};
  const temperature = current.temperature_2m ?? 0;

  return {
    apparentC: Math.round(current.apparent_temperature ?? temperature),
    city: location.city,
    condition: mapWeatherCode(current.weather_code ?? 3, current.is_day !== 0),
    highC: Math.round(daily.temperature_2m_max?.[0] ?? temperature),
    humidity:
      typeof current.relative_humidity_2m === "number"
        ? Math.round(current.relative_humidity_2m)
        : null,
    lowC: Math.round(daily.temperature_2m_min?.[0] ?? temperature),
    temperatureC: Math.round(temperature),
    updatedAt: new Date().toISOString(),
    windMph:
      typeof current.wind_speed_10m === "number"
        ? Math.round(current.wind_speed_10m)
        : null,
  };
}
