interface BuyMeCoffeeButtonProps {
  isDark: boolean;
}

export function BuyMeCoffeeButton({ isDark }: BuyMeCoffeeButtonProps) {
  return (
    <a
      href="https://www.buymeacoffee.com/weiclee"
      target="_blank"
      rel="noopener noreferrer"
      className={`bmc-btn ${isDark ? 'bmc-btn-dark' : 'bmc-btn-light'}`}
      aria-label="Buy me a coffee"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="bmc-icon"
      >
        {/* Steam lines */}
        <path d="M6 2v2M10 2v2M14 2v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        {/* Cup body */}
        <path
          d="M4 7h14v9a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V7z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        {/* Handle */}
        <path
          d="M18 9h1a3 3 0 0 1 0 6h-1"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
      <span className="bmc-text">buy me a coffee</span>
    </a>
  );
}
