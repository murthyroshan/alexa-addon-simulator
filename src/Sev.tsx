// Severity in words, not coloured dots: "Fix", "Improve", "Good", "Note".
const SEV = { fail: 'Fix', warn: 'Improve', pass: 'Good', info: 'Note' } as const;

export function Sev({ level }: { level: keyof typeof SEV }) {
  return <span className={`sev ${level}`}>{SEV[level]}</span>;
}
