import type { SVGProps } from "react";

export type LogoProps = SVGProps<SVGSVGElement> & { size?: number };

export function Logo({ size = 48, width, height, ...props }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      fill="none"
      width={width ?? size}
      height={height ?? size}
      aria-hidden="true"
      {...props}
    >
      <defs>
        <linearGradient
          id="logo-lg"
          x1="8"
          y1="6"
          x2="42"
          y2="44"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#4ae8dc" />
          <stop offset="0.45" stopColor="#34d3c9" />
          <stop offset="1" stopColor="#1fa89f" />
        </linearGradient>
        <linearGradient
          id="logo-glow"
          x1="24"
          y1="8"
          x2="24"
          y2="40"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#34d3c9" stopOpacity="0.35" />
          <stop offset="1" stopColor="#34d3c9" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="14" fill="#0e1218" />
      <rect
        x="1"
        y="1"
        width="46"
        height="46"
        rx="13"
        stroke="url(#logo-lg)"
        strokeWidth="1.5"
        fill="none"
        opacity="0.9"
      />
      <ellipse cx="24" cy="38" rx="18" ry="6" fill="url(#logo-glow)" />
      <path
        d="M8 28c2.5-5 5-9 8.5-9s5.5 4 8 9 5.5 9 9 9 6.5-4 9-9 5.5-9 9-9"
        stroke="url(#logo-lg)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle
        cx="24"
        cy="28"
        r="11"
        stroke="url(#logo-lg)"
        strokeWidth="2"
        fill="#0a0c10"
      />
      <circle
        cx="24"
        cy="28"
        r="6"
        stroke="url(#logo-lg)"
        strokeWidth="1.2"
        strokeOpacity="0.45"
        fill="none"
      />
      <circle cx="24" cy="28" r="2.2" fill="url(#logo-lg)" />
    </svg>
  );
}
