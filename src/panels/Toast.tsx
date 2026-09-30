import { useStore } from '../store.ts';

export function Toast() {
  const toast = useStore((s) => s.toast);
  const set = useStore((s) => s.set);
  if (!toast) return null;
  const { action } = toast;
  return (
    <div className={`toast t-${toast.tone}`} role="status" aria-live="polite">
      <span>{toast.text}</span>
      {action && (
        <button
          type="button"
          className="btn small"
          onClick={() => {
            action.run();
            set({ toast: null });
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
