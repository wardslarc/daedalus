"use client";

import { postJson } from "../csrf-fetch";

export function LogoutButton() {
  return (
    <button
      type="button"
      onClick={async () => {
        await postJson("/api/logout");
        window.location.assign("/login");
      }}
    >
      Sign out
    </button>
  );
}
