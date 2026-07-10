/**
 * A minimal Command pattern with an undo/redo history — the editing foundation
 * the v3 concept (§3) calls for: "every edit is a serialisable command → undo/
 * redo for free". A {@link Command} bundles a mutation with its inverse; the
 * {@link CommandStore} runs it and remembers how to reverse it.
 *
 * Framework-agnostic (no GTK/DOM): the app wraps a store and re-renders on its
 * change callback. Commands here mutate their target in place, so the holder's
 * object identity is preserved and views can keep their reference.
 */

/** A reversible edit: {@link do} applies it, {@link undo} reverses it exactly. */
export interface Command {
  /** Short human label for the history (e.g. "Leitung verlegen"). */
  label: string;
  do(): void;
  undo(): void;
}

/**
 * An undo/redo history over {@link Command}s. `execute` runs a command and pushes
 * it onto the undo stack (clearing the redo stack, the standard linear-history
 * rule). Each mutating call fires the `onChange` callback so a UI can refresh.
 */
export class CommandStore {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  constructor(private readonly onChange?: () => void) {}

  /** Run a command and record it; drops any redoable future. */
  execute(cmd: Command): void {
    cmd.do();
    this.undoStack.push(cmd);
    this.redoStack = [];
    this.onChange?.();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Label of the command that would be undone next, or null. */
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  /** Label of the command that would be redone next, or null. */
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.onChange?.();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.do();
    this.undoStack.push(cmd);
    this.onChange?.();
  }

  /** Forget the whole history (e.g. when a new document is loaded). */
  clear(): void {
    const had = this.undoStack.length > 0 || this.redoStack.length > 0;
    this.undoStack = [];
    this.redoStack = [];
    if (had) this.onChange?.();
  }
}
