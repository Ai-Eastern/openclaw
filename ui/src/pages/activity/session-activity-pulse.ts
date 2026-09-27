import { html, nothing } from "lit";
import type { SessionActivityPulse } from "../../../../src/shared/session-types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";

registerActivityEnglish();

export function renderSessionActivityPulse(pulse: SessionActivityPulse, now: number) {
  const hour = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  const label = (index: number) => hour.format(pulse.since + index * 3_600_000);
  const current = Math.max(0, Math.min(23, Math.floor((now - pulse.since) / 3_600_000)));
  const peak = Math.max(...pulse.hours);
  const stats = [
    ["sessions", pulse.sessions],
    ["started", pulse.started],
    ["people", pulse.people],
    ["running", pulse.running],
  ] as const;
  return html`<section class="activity-pulse">
    <div class="activity-pulse__header">
      <div class="activity-pulse__heading">
        ${icons.activity}<strong>${t("activityFeed.today")}</strong>
        <span
          >${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now)}</span
        >
      </div>
      <div class="activity-pulse__stats">
        ${stats
          .filter(([, value]) => value !== undefined)
          .map(
            ([key, value], index) => html`
              ${index ? " · " : nothing}<span
                >${key === "running" && pulse.running > 0 ? html`<i class="activity-pulse__running" aria-hidden="true"></i>` : nothing}<b
                  >${value}</b
                >
                ${t(`activity.pulse.${key}`)}</span
              >
            `,
          )}
      </div>
    </div>
    <div
      class="activity-pulse__bars"
      role="img"
      aria-label=${t("activity.pulse.description", { count: String(pulse.sessions), hour: label(pulse.hours.indexOf(peak)) })}
    >
      ${pulse.hours.map(
        (count, index) => html`<span
          class="activity-pulse__bar"
          data-hour=${index === current ? "current" : index < current ? "past" : "future"}
          style=${`height: max(2px, ${index <= current && peak > 0 ? (count / peak) * 100 : 0}%)`}
          title=${t("activity.pulse.hour", { hour: label(index), count: String(count) })}
        ></span>`,
      )}
    </div>
    <div class="activity-pulse__axis" aria-hidden="true">
      ${[0, 6, 12, 18, 24].map((index) => html`<span>${label(index)}</span>`)}
    </div>
  </section>`;
}
