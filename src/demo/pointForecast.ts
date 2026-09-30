/**
 * Point forecast strip. A horizontally scrolling table docked above the
 * timeline: one column per forecast hour, one row per active layer, showing
 * the value at a clicked point. Cells fill in as each hour's data arrives.
 * Clicking a column moves the timeline to that hour.
 */

export interface ForecastHour {
  fhour: number;
  valid: Date;
}

export interface ForecastCell {
  text: string;
  /** CSS color behind the value, e.g. from the layer's colormap. */
  background?: string;
  /** Direction the wind blows from, degrees clockwise from north. */
  fromDeg?: number;
}

export interface PointForecastOptions {
  parent: HTMLElement;
  onSelectHour: (fhour: number) => void;
  onClose: () => void;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class PointForecast {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private body: HTMLElement;
  /** cells[row] maps forecast hour -> <td>. */
  private cells: Array<Map<number, HTMLElement>> = [];
  private hourCells = new Map<number, HTMLElement>();
  private onSelectHour: (fhour: number) => void;

  constructor(opts: PointForecastOptions) {
    this.onSelectHour = opts.onSelectHour;

    this.root = document.createElement('div');
    this.root.id = 'forecast-strip';
    this.root.style.display = 'none';

    const header = document.createElement('div');
    header.className = 'forecast-header';
    this.titleEl = document.createElement('span');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'forecast-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close forecast';
    closeBtn.addEventListener('click', () => {
      this.close();
      opts.onClose();
    });
    header.append(this.titleEl, closeBtn);

    this.body = document.createElement('div');
    this.body.className = 'forecast-body';

    this.root.append(header, this.body);
    opts.parent.appendChild(this.root);
  }

  /** Show an empty table; cells read as loading until setCell fills them. */
  open(title: string, hours: ForecastHour[], rowLabels: string[]): void {
    this.show(title);
    this.cells = [];
    this.hourCells.clear();

    const table = document.createElement('table');
    const dayRow = table.insertRow();
    const hourRow = table.insertRow();
    dayRow.appendChild(document.createElement('th'));
    hourRow.appendChild(document.createElement('th'));

    let dayCell: HTMLTableCellElement | null = null;
    let dayKey = '';
    for (const { fhour, valid } of hours) {
      const key = valid.toDateString();
      if (key !== dayKey || !dayCell) {
        dayKey = key;
        dayCell = document.createElement('th');
        dayCell.className = 'forecast-day';
        dayCell.textContent = `${DAYS[valid.getDay()]!} ${valid.getMonth() + 1}/${valid.getDate()}`;
        dayRow.appendChild(dayCell);
      } else {
        dayCell.colSpan += 1;
      }

      const hr = valid.getHours();
      const th = document.createElement('th');
      th.className = 'forecast-hour';
      th.textContent = `${hr % 12 === 0 ? 12 : hr % 12}${hr >= 12 ? 'pm' : 'am'}`;
      th.addEventListener('click', () => this.onSelectHour(fhour));
      hourRow.appendChild(th);
      this.hourCells.set(fhour, th);
    }

    for (const label of rowLabels) {
      const tr = table.insertRow();
      const th = document.createElement('th');
      th.className = 'forecast-label';
      th.textContent = label;
      tr.appendChild(th);
      const row = new Map<number, HTMLElement>();
      for (const { fhour } of hours) {
        const td = tr.insertCell();
        td.className = 'forecast-cell loading';
        td.textContent = '·';
        td.dataset.hour = String(fhour);
        td.addEventListener('click', () => this.onSelectHour(fhour));
        row.set(fhour, td);
      }
      this.cells.push(row);
    }

    this.body.replaceChildren(table);
  }

  /** Show a message in place of the table. */
  showMessage(title: string, message: string): void {
    this.show(title);
    this.cells = [];
    this.hourCells.clear();
    const el = document.createElement('div');
    el.className = 'forecast-message';
    el.textContent = message;
    this.body.replaceChildren(el);
  }

  /** Fill one cell. Pass null where the layer has no data for that hour. */
  setCell(row: number, fhour: number, cell: ForecastCell | null): void {
    const td = this.cells[row]?.get(fhour);
    if (!td) return;
    td.classList.remove('loading');
    td.textContent = cell?.text ?? '–';
    td.style.background = cell?.background ?? '';
    if (cell?.fromDeg !== undefined) {
      const arrow = document.createElement('span');
      arrow.className = 'forecast-arrow';
      arrow.textContent = '↓'; // points the way the wind is blowing
      arrow.style.transform = `rotate(${cell.fromDeg.toFixed(0)}deg)`;
      td.append(' ', arrow);
    }
  }

  setActiveHour(fhour: number): void {
    for (const [h, th] of this.hourCells) th.classList.toggle('active', h === fhour);
    for (const row of this.cells) {
      for (const [h, td] of row) td.classList.toggle('active', h === fhour);
    }
    this.hourCells.get(fhour)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  close(): void {
    this.root.style.display = 'none';
    document.documentElement.classList.remove('forecast-open');
  }

  private show(title: string): void {
    this.titleEl.textContent = title;
    this.root.style.display = '';
    document.documentElement.classList.add('forecast-open');
  }
}
