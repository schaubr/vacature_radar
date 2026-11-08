export interface Notifier {
  notify(n: { title: string; body: string; vacancyId?: number }): void;
}

/** Notifier that discards everything (CLI, tests). */
export const nullNotifier: Notifier = { notify: () => {} };
