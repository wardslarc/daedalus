"use client";

import { useEffect, useState, type ButtonHTMLAttributes } from "react";
import { postJson } from "../csrf-fetch";

export function LogoutButton({ className, style, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <button
      type="button"
      className={className}
      style={style}
      disabled={!hydrated}
      onClick={async () => {
        await postJson("/api/logout");
        window.location.assign("/login");
      }}
      {...props}
    >
      {children ?? "Sign out"}
    </button>
  );
}
