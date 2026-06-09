import { describe, expect, it } from "vitest";
import { moodEmoji } from "./notesEmoji";

describe("moodEmoji", () => {
  it("uses a default emoji for empty or unknown text", () => {
    expect(moodEmoji("")).toBe("📝");
    expect(moodEmoji("random family thought")).toBe("📝");
  });

  it("matches bilingual household note keywords", () => {
    expect(moodEmoji("Comprar leite")).toBe("🥛");
    expect(moodEmoji("take the trash out")).toBe("🗑️");
    expect(moodEmoji("te amo")).toBe("❤️");
    expect(moodEmoji("birthday cake")).toBe("🎂");
    expect(moodEmoji("call the dentist")).toBe("🩺");
    expect(moodEmoji("limpar a cozinha")).toBe("🧹");
    expect(moodEmoji("buy groceries")).toBe("🛒");
  });

  it("prioritizes specific milk text over generic shopping text", () => {
    expect(moodEmoji("comprar leite")).toBe("🥛");
  });
});
