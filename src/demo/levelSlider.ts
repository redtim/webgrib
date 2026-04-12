/**
 * Vertical level slider. Shows available atmospheric levels for the
 * current variable. Clicking a level or using up/down arrows changes
 * the active level and fires onChange.
 *
 * Levels are displayed bottom-to-top (surface at bottom, upper atm at top)
 * to match the physical atmosphere.
 */

import type { VariableLevel } from '../renderer/catalog.js';

export interface LevelSliderOptions {
  parent: HTMLElement;
  onChange: (levelIndex: number) => void;
}

export class LevelSlider {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private titleEl: HTMLElement;
  private levels: VariableLevel[] = [];
  private _index = 0;
  private onChange: (levelIndex: number) => void;
  private buttons: HTMLButtonElement[] = [];

  get index(): number { return this._index; }
  get currentLevel(): VariableLevel | undefined { return this.levels[this._index]; }

  constructor(opts: LevelSliderOptions) {
    this.onChange = opts.onChange;

    this.container = document.createElement('div');
    this.container.className = 'level-slider';
    this.container.style.display = 'none';

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'level-slider-title';
    this.titleEl.textContent = 'Level';

    this.listEl = document.createElement('div');
    this.listEl.className = 'level-slider-list';

    this.container.append(this.titleEl, this.listEl);
    opts.parent.appendChild(this.container);
  }

  /** Set available levels for a variable. Resets to index 0. */
  setLevels(levels: VariableLevel[]): void {
    this.levels = levels;
    this.buttons = [];
    this.listEl.innerHTML = '';

    if (levels.length <= 1) {
      this.container.style.display = 'none';
      this._index = 0;
      return;
    }

    this.container.style.display = '';

    // Render bottom-to-top: last level (highest altitude) at top of list
    for (let i = levels.length - 1; i >= 0; i--) {
      const btn = document.createElement('button');
      btn.className = 'level-btn';
      btn.textContent = levels[i]!.label;
      btn.dataset.index = String(i);
      btn.addEventListener('click', () => this.select(i));
      this.listEl.appendChild(btn);
      this.buttons.push(btn);
    }

    this._index = 0;
    this.highlightActive();
  }

  /** Select a specific level by index. */
  select(index: number): void {
    if (index < 0 || index >= this.levels.length || index === this._index) return;
    this._index = index;
    this.highlightActive();
    this.onChange(index);
  }

  /** Step up (higher altitude = higher index) or down by delta. */
  step(delta: number): void {
    const next = Math.max(0, Math.min(this.levels.length - 1, this._index + delta));
    if (next !== this._index) this.select(next);
  }

  /** Returns true if this slider is visible (multi-level variable). */
  isVisible(): boolean {
    return this.levels.length > 1;
  }

  private highlightActive(): void {
    for (const btn of this.buttons) {
      btn.classList.toggle('active', btn.dataset.index === String(this._index));
    }
  }
}
