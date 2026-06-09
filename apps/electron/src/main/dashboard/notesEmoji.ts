const DEFAULT_EMOJI = "📝";

const TABLE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["🥛", ["milk", "leite"]],
  ["🗑️", ["trash", "garbage", "rubbish", "lixo"]],
  ["❤️", ["for you", "love", "amor", "te amo", "beijo", "xoxo", "querido", "querida"]],
  ["🎂", ["birthday", "cake", "party", "aniversário", "aniversario", "festa", "bolo"]],
  [
    "🩺",
    [
      "doctor",
      "dentist",
      "hospital",
      "pharmacy",
      "médico",
      "medico",
      "dentista",
      "remédio",
      "remedio",
      "farmácia",
      "farmacia",
    ],
  ],
  ["📞", ["call", "phone", "ligar", "ligação", "ligacao", "telefone"]],
  ["🧹", ["clean", "vacuum", "faxina", "limpar", "limpeza"]],
  ["🛒", ["buy", "shop", "groceries", "comprar", "compras", "mercado", "supermercado"]],
];

export function moodEmoji(text: string): string {
  const haystack = text.toLowerCase();

  if (!haystack.trim()) {
    return DEFAULT_EMOJI;
  }

  for (const [emoji, keywords] of TABLE) {
    if (keywords.some((keyword) => haystack.includes(keyword))) {
      return emoji;
    }
  }

  return DEFAULT_EMOJI;
}
