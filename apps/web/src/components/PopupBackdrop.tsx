interface PopupBackdropProps {
  isDark: boolean;
  onDismiss: () => void;
  className?: string;
}

export function PopupBackdrop({ isDark, onDismiss, className = '' }: PopupBackdropProps) {
  return (
    <div
      aria-hidden="true"
      className={[
        'popup-backdrop',
        isDark ? 'popup-backdrop-dark' : 'popup-backdrop-light',
        className,
      ].filter(Boolean).join(' ')}
      onPointerDown={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    />
  );
}
