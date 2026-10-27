// `p`: set or clear an issue's estimate.

import { updateIssue } from "../linear/api.ts";
import type { Card } from "../linear/types.ts";
import { formatPoints, type Item } from "../render/layout.ts";
import type { Line } from "../render/line.ts";
import { drawBox, type Dialog, type DialogHost, type Key } from "./dialog.ts";

/** The estimates each of Linear's scales allows; t-shirt sizes are stored as numbers. */
const SCALES: Record<string, string> = {
  fibonacci: "0 1 2 3 5 8", exponential: "0 1 2 4 8 16", linear: "0 1 2 3 4 5", tShirt: "XS 1 · S 2 · M 3 · L 5 · XL 8",
};

class PointsDialog implements Dialog {
  host: DialogHost;
  card: Card;
  scale: string;
  text: string;
  prefilled = true; // text is still the current value: the first digit replaces it

  constructor(host: DialogHost, card: Card, scale: string) {
    this.host = host;
    this.card = card;
    this.scale = scale;
    this.text = card.points == null ? "" : formatPoints(card.points);
  }

  async key(str: string | undefined, key: Key): Promise<void> {
    if (key.name === "escape") {
      this.host.close();
    } else if (key.name === "return" || key.name === "enter") {
      await this.save();
    } else if (key.name === "backspace") {
      this.text = this.text.slice(0, -1);
      this.prefilled = false;
    } else if (str && /^[0-9]$/.test(str)) {
      if (this.prefilled) this.text = "";
      this.prefilled = false;
      if (this.text.length < 3) this.text += str;
    }
  }

  async save(): Promise<void> {
    const text = this.text.trim();
    const value = text === "" ? null : Number(text);
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      this.host.msg = `"${text}" is not an estimate`;
      return;
    }
    const { card } = this;
    await this.host.perform(`saving the estimate of ${card.key}…`, async () => {
      await updateIssue(card.id, { estimate: value });
      card.points = value;
      return value === null ? `${card.key}: estimate cleared` : `${card.key}: estimate ${formatPoints(value)}`;
    }, (message) => `saving the estimate failed: ${message}`);
  }

  draw(rows: Line[]): void {
    const now = this.card.points == null ? "none" : formatPoints(this.card.points);
    const usual = SCALES[this.scale] ? `  ·  ${this.scale}: ${SCALES[this.scale]}` : "";
    drawBox(rows, this.host, `Estimate of ${this.card.key}: ${this.card.fields.summary}`, [
      { line: [["currently ", "dim"], [now, "points"], [usual, "dim"]] },
      "rule",
      { line: [["› ", "dim"], [this.text, this.prefilled ? "rev" : null], ["█", "dim"]] },
    ], "⏎ save · type to replace · empty clears · esc cancel");
  }
}

export function openPoints(host: DialogHost, item: Item): Dialog | null {
  const scale = host.board.teamInfo?.issueEstimationType;
  if (!host.board.pointsField || !scale) {
    host.msg = "this team does not estimate its issues (turn it on in Linear's team settings)";
    return null;
  }
  // estimates are counted on the cards, not their sub-issues
  return new PointsDialog(host, item.parent ?? (item.issue as Card), scale);
}
