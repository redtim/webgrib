/**
 * Grouped layer picker panel. Shows variables from the catalog.
 * Clicking a variable fires the onSelect callback. Variables with
 * multiple levels show the level count as a badge.
 */

import { CATALOG, GROUPS } from '../renderer/catalog.js';
import type { CatalogVariable } from '../renderer/catalog.js';

export interface PanelOptions {
  parent: HTMLElement;
  onSelect: (variable: CatalogVariable) => void;
}

export class Panel {
  private container: HTMLElement;
  private activeId: string | null = null;
  private onSelect: (variable: CatalogVariable) => void;
  private itemElements = new Map<string, HTMLElement>();

  constructor(opts: PanelOptions) {
    this.onSelect = opts.onSelect;

    this.container = document.createElement('div');
    this.container.className = 'layer-panel';

    for (const group of GROUPS) {
      const variables = CATALOG.filter((v) => v.group === group);
      const section = document.createElement('div');
      section.className = 'layer-group';

      const header = document.createElement('div');
      header.className = 'layer-group-header';
      header.textContent = group;
      header.addEventListener('click', () => {
        section.classList.toggle('collapsed');
      });

      const list = document.createElement('div');
      list.className = 'layer-group-list';
      for (const variable of variables) {
        const item = document.createElement('div');
        item.className = 'layer-item';
        item.dataset.id = variable.id;

        const kindBadge = document.createElement('span');
        kindBadge.className = `layer-kind layer-kind-${variable.kind}`;
        kindBadge.textContent = variable.kind === 'wind' ? 'W' : 'S';
        kindBadge.title = variable.kind === 'wind' ? 'Wind particles' : 'Scalar field';

        const label = document.createElement('span');
        label.className = 'layer-label';
        label.textContent = variable.label;

        item.append(kindBadge, label);

        // Show level count for multi-level variables
        if (variable.levels.length > 1) {
          const lvlBadge = document.createElement('span');
          lvlBadge.className = 'layer-levels-badge';
          lvlBadge.textContent = `${variable.levels.length} lvl`;
          lvlBadge.title = variable.levels.map((l) => l.label).join(', ');
          item.appendChild(lvlBadge);
        }

        item.addEventListener('click', () => {
          this.setActive(variable.id);
          this.onSelect(variable);
        });
        list.appendChild(item);
        this.itemElements.set(variable.id, item);
      }

      section.append(header, list);
      this.container.appendChild(section);
    }

    opts.parent.appendChild(this.container);
  }

  setActive(id: string): void {
    if (this.activeId) {
      this.itemElements.get(this.activeId)?.classList.remove('active');
    }
    this.activeId = id;
    this.itemElements.get(id)?.classList.add('active');
  }

  getActiveId(): string | null {
    return this.activeId;
  }
}
