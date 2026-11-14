// Drawn icons on one 16px grid with one 1.5px stroke and round joins, matching the brand
// mark's line language. All are decorative: a label next to each carries the meaning.

import type { SVGProps } from "react";

export type IconName =
  | "refresh"
  | "plus"
  | "arrow-up"
  | "arrow-down"
  | "arrow-right"
  | "trash"
  | "copy"
  | "check"
  | "close"
  | "eye"
  | "eye-off"
  | "flag"
  | "chevron"
  | "warning"
  | "dash"
  | "external"
  | "overview"
  | "providers"
  | "routes"
  | "playground"
  | "logs"
  | "settings"
  | "sign-out"
  | "key"
  | "bolt"
  | "table"
  | "chart";

const PATHS: Record<IconName, string> = {
  refresh: "M13.2 8a5.2 5.2 0 1 1-1.6-3.75M13.4 2.6v2.6h-2.6",
  plus: "M8 3.25v9.5M3.25 8h9.5",
  "arrow-up": "M8 13V3.5M4.25 7.25 8 3.5l3.75 3.75",
  "arrow-down": "M8 3v9.5M4.25 8.75 8 12.5l3.75-3.75",
  "arrow-right": "M3 8h9.5M8.75 4.25 12.5 8l-3.75 3.75",
  trash: "M2.75 4.5h10.5M6.25 4.5V2.75h3.5V4.5M4.25 4.5l.6 8.75h6.3l.6-8.75",
  copy: "M5.75 5.75h7v7.5h-7zM3.25 10.25V2.75h7",
  check: "M3.25 8.5 6.4 11.5 12.75 4.75",
  close: "M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5",
  eye: "M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  "eye-off":
    "M2.5 2.5l11 11M6.4 6.5A2 2 0 0 0 9.5 9.6M4.1 4.6C2.6 5.8 1.75 8 1.75 8S4 12.25 8 12.25c1.3 0 2.4-.4 3.3-1M7.3 3.8c.2 0 .5-.05.7-.05 4 0 6.25 4.25 6.25 4.25s-.5 1-1.5 2",
  flag: "M4 13.5v-11M4 3h8l-1.75 2.6L12 8.25H4",
  chevron: "M6 3.75 10.25 8 6 12.25",
  warning: "M8 2.5 14 13H2zM8 6.5v3M8 11.25v.25",
  dash: "M3.5 8h9",
  external: "M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11 9.5v3.75H2.75V5H6.5",
  overview: "M2.5 13.25h11M4 10.75V8M7 10.75V4.5M10 10.75V6.5M13 10.75V3",
  providers:
    "M3 5.25a1.75 1.75 0 1 0 0-.01M13 5.25a1.75 1.75 0 1 0 0-.01M8 12.25a1.75 1.75 0 1 0 0-.01M4.5 6.5l2.5 4.25M11.5 6.5 9 10.75M4.75 5.25h6.5",
  routes: "M2.25 8h3.5l2.5-3.5h5.5M5.75 8l2.5 3.5h5.5M5.75 8a.01.01 0 1 0 0 0",
  playground: "M4.5 3.25v9.5L12.75 8z",
  logs: "M2.75 4h10.5M2.75 8h10.5M2.75 12h6.5",
  settings:
    "M8 10.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.05 1.05M4.65 11.35 3.6 12.4M12.4 12.4l-1.05-1.05M4.65 4.65 3.6 3.6",
  "sign-out": "M6.5 2.75H3v10.5h3.5M10 5l3 3-3 3M13 8H6.25",
  key: "M5.75 10.25a2.75 2.75 0 1 1 2.6-3.6h5.4v2h-1.5v1.6h-1.75V8.65H8.35a2.75 2.75 0 0 1-2.6 1.6z",
  bolt: "M9 1.75 3.75 9h4l-1 5.25L12.25 7h-4z",
  table: "M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.75h11M6.5 6.5V13",
  chart: "M2.5 13h11M3.5 10.5l3-3.5 2.5 2 4-5",
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, className, ...rest }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
