// Logo de crochetisse: un aguacate
export default function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" role="img" aria-label="crochetisse">
      <path d="M50 6c-11 0-17 12-20 24-4 14-12 24-12 38 0 16 13 26 32 26s32-10 32-26c0-14-8-24-12-38C67 18 61 6 50 6z" fill="#5f7a3f" />
      <path d="M50 14c-8 0-13 10-15.500 20-3.500 13-11 23-11 34 0 12.500 10.500 21 26.500 21s26.500-8.500 26.500-21c0-11-7.500-21-11-34C63 24 58 14 50 14z" fill="#d7e3a6" />
      <circle cx="50" cy="62" r="14" fill="#8d6b5a" />
      <circle cx="45" cy="57" r="4" fill="#fff" opacity="0.35" />
    </svg>
  )
}
