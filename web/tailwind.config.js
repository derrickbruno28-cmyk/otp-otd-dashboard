/** Theme colors come from docs/BRAND.md via CSS variables in src/theme.css. */
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ground: "rgb(var(--c-ground) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        surface2: "rgb(var(--c-surface-2) / <alpha-value>)",
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        ink2: "rgb(var(--c-ink-2) / <alpha-value>)",
        ink3: "rgb(var(--c-ink-3) / <alpha-value>)",
        rule: "rgb(var(--c-rule) / <alpha-value>)",
        ruleStrong: "rgb(var(--c-rule-strong) / <alpha-value>)",
        brand: "rgb(var(--c-brand) / <alpha-value>)",
        brandInk: "rgb(var(--c-brand-ink) / <alpha-value>)",
        nav: "rgb(var(--c-nav) / <alpha-value>)",
        ontime: "rgb(var(--c-ontime) / <alpha-value>)",
        ontimeSoft: "rgb(var(--c-ontime-soft) / <alpha-value>)",
        late: "rgb(var(--c-late) / <alpha-value>)",
        lateSoft: "rgb(var(--c-late-soft) / <alpha-value>)",
        pending: "rgb(var(--c-pending) / <alpha-value>)",
        pendingSoft: "rgb(var(--c-pending-soft) / <alpha-value>)",
        catDriver: "rgb(var(--c-cat-driver) / <alpha-value>)",
        catOther: "rgb(var(--c-cat-other) / <alpha-value>)",
      },
      fontFamily: {
        display: ['"Saira Semi Condensed"', "system-ui", "sans-serif"],
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
