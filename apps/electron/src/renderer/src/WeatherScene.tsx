import { useMemo } from "react";

interface Particle {
  delay: number;
  duration: number;
  key: string;
  left: number;
  size: number;
  top: number;
}

function makeParticles(count: number, top: number): Particle[] {
  return Array.from({ length: count }, () => ({
    delay: Math.random(),
    duration: 1,
    key: Math.random().toString(36).slice(2),
    left: Math.random() * 100,
    size: 1,
    top: Math.random() * top,
  }));
}

export function WeatherScene({
  category,
  isDay,
}: {
  category: WeatherCategory;
  isDay: boolean;
}): React.JSX.Element {
  const showSun =
    isDay && (category === "clear" || category === "partly-cloudy");
  const showMoon =
    !isDay && (category === "clear" || category === "partly-cloudy");
  const cloudCount =
    category === "cloudy" || category === "thunder"
      ? 3
      : category === "partly-cloudy" ||
          category === "rain" ||
          category === "drizzle" ||
          category === "snow"
        ? 2
        : 0;
  const isWet =
    category === "drizzle" || category === "rain" || category === "thunder";

  return (
    <div className="wx-scene" aria-hidden="true">
      {showSun ? <Sun /> : null}
      {showMoon ? <Moon /> : null}
      {category === "clear" && !isDay ? <Stars /> : null}
      {cloudCount > 0 ? (
        <Clouds count={cloudCount} dark={isWet || category === "snow"} />
      ) : null}
      {isWet ? <Rain dense={category !== "drizzle"} /> : null}
      {category === "snow" ? <Snow /> : null}
      {category === "fog" ? <Fog /> : null}
      {category === "thunder" ? <span className="wx-lightning" /> : null}
    </div>
  );
}

function Sun(): React.JSX.Element {
  return (
    <div className="wx-sun">
      <span className="wx-sun-rays" />
      <span className="wx-sun-core" />
    </div>
  );
}

function Moon(): React.JSX.Element {
  return (
    <div className="wx-moon">
      <span className="wx-moon-core" />
    </div>
  );
}

function Stars(): React.JSX.Element {
  const stars = useMemo(() => makeParticles(30, 65), []);

  return (
    <div className="wx-stars">
      {stars.map((star) => (
        <span
          className="wx-star"
          key={star.key}
          style={{
            animationDelay: `${star.delay * 3}s`,
            left: `${star.left}%`,
            top: `${star.top}%`,
          }}
        />
      ))}
    </div>
  );
}

function Clouds({
  count,
  dark,
}: {
  count: number;
  dark: boolean;
}): React.JSX.Element {
  const clouds = useMemo(
    () =>
      Array.from({ length: count }, (_unused, index) => ({
        delay: -Math.random() * 30,
        duration: 28 + Math.random() * 22,
        key: Math.random().toString(36).slice(2),
        scale: 0.85 + Math.random() * 0.6,
        top: 8 + index * 24 + Math.random() * 8,
      })),
    [count],
  );

  return (
    <div className="wx-clouds">
      {clouds.map((cloud) => (
        <span
          className="wx-cloud-track"
          key={cloud.key}
          style={{
            animationDelay: `${cloud.delay}s`,
            animationDuration: `${cloud.duration}s`,
            top: `${cloud.top}%`,
          }}
        >
          <span
            className={dark ? "wx-cloud wx-cloud--dark" : "wx-cloud"}
            style={{ transform: `scale(${cloud.scale})` }}
          />
        </span>
      ))}
    </div>
  );
}

function Rain({ dense }: { dense: boolean }): React.JSX.Element {
  const drops = useMemo(
    () =>
      Array.from({ length: dense ? 64 : 32 }, () => ({
        delay: Math.random() * 1.2,
        duration: 0.5 + Math.random() * 0.4,
        key: Math.random().toString(36).slice(2),
        left: Math.random() * 100,
      })),
    [dense],
  );

  return (
    <div className="wx-rain">
      {drops.map((drop) => (
        <span
          className="wx-drop"
          key={drop.key}
          style={{
            animationDelay: `${drop.delay}s`,
            animationDuration: `${drop.duration}s`,
            left: `${drop.left}%`,
          }}
        />
      ))}
    </div>
  );
}

function Snow(): React.JSX.Element {
  const flakes = useMemo(
    () =>
      Array.from({ length: 44 }, () => ({
        delay: Math.random() * 5,
        duration: 4 + Math.random() * 4,
        key: Math.random().toString(36).slice(2),
        left: Math.random() * 100,
        size: 3 + Math.random() * 4,
      })),
    [],
  );

  return (
    <div className="wx-snow">
      {flakes.map((flake) => (
        <span
          className="wx-flake"
          key={flake.key}
          style={{
            animationDelay: `${flake.delay}s`,
            animationDuration: `${flake.duration}s`,
            height: `${flake.size}px`,
            left: `${flake.left}%`,
            width: `${flake.size}px`,
          }}
        />
      ))}
    </div>
  );
}

function Fog(): React.JSX.Element {
  return (
    <div className="wx-fog">
      {[0, 1, 2, 3].map((band) => (
        <span
          className="wx-fog-band"
          key={band}
          style={{ animationDelay: `${-band * 4}s`, top: `${15 + band * 22}%` }}
        />
      ))}
    </div>
  );
}
