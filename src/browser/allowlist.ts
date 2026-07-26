/**
 * Curated @playwright/mcp tools exposed through the `ui` toolset.
 *
 * This is an allowlist, not a blocklist: only names here are registered even when
 * the upstream server advertises more (storage, navigation, close, etc.).
 */

/** Tools that must never be forwarded even if they appear in listTools(). */
export const BLOCKED_BROWSER_TOOLS = new Set([
  "browser_close",
  "browser_navigate",
  "browser_navigate_back",
  "browser_navigate_forward",
  "browser_resize",
  "browser_run_code_unsafe",
  "browser_file_upload",
  "browser_pdf_save",
  "browser_storage_state",
  "browser_set_storage_state",
  "browser_network_request",
  "browser_network_requests",
  "browser_network_clear",
  "browser_console_clear",
]);

/**
 * Core interaction surface with `vision` + `testing` capabilities enabled upstream.
 * Count: 27 proxied tools at @playwright/mcp@0.0.78.
 */
export const ALLOWED_BROWSER_TOOLS = new Set([
  "browser_click",
  "browser_console_messages",
  "browser_drag",
  "browser_drop",
  "browser_evaluate",
  "browser_fill_form",
  "browser_find",
  "browser_generate_locator",
  "browser_handle_dialog",
  "browser_hover",
  "browser_mouse_click_xy",
  "browser_mouse_down",
  "browser_mouse_drag_xy",
  "browser_mouse_move_xy",
  "browser_mouse_up",
  "browser_mouse_wheel",
  "browser_press_key",
  "browser_select_option",
  "browser_snapshot",
  "browser_tabs",
  "browser_take_screenshot",
  "browser_type",
  "browser_verify_element_visible",
  "browser_verify_list_visible",
  "browser_verify_text_visible",
  "browser_verify_value",
  "browser_wait_for",
]);

export function isAllowedBrowserTool(name: string): boolean {
  return ALLOWED_BROWSER_TOOLS.has(name) && !BLOCKED_BROWSER_TOOLS.has(name);
}

/**
 * Proxied tools that deliver real mouse or keyboard input.
 *
 * Two things key off this set. The vault fence re-points the proxy at the
 * authorized window before each of these, and `FocusEmulator` wraps them so the
 * input lands even when Obsidian is not the foreground window. Read-only tools are
 * excluded on purpose: they need neither, and holding a shared lock while toggling
 * emulation would let a reader flip it off under a concurrent write.
 */
export const INPUT_BROWSER_TOOLS = new Set([
  "browser_click",
  "browser_drag",
  "browser_drop",
  "browser_fill_form",
  "browser_handle_dialog",
  "browser_hover",
  "browser_mouse_click_xy",
  "browser_mouse_down",
  "browser_mouse_drag_xy",
  "browser_mouse_move_xy",
  "browser_mouse_up",
  "browser_mouse_wheel",
  "browser_press_key",
  "browser_select_option",
  "browser_type",
]);

export function isInputBrowserTool(name: string): boolean {
  return INPUT_BROWSER_TOOLS.has(name);
}

/**
 * `browser_tabs` actions knapper will forward.
 *
 * `select` and `close` are the only allowlisted levers that can move the proxy off
 * the window the fence just pointed it at — `select` silently, `close` permanently.
 * Listing tabs is the useful half and cannot retarget anything, so that is the half
 * we keep. knapper drives tab selection itself via `obsidian_attach`.
 */
export const ALLOWED_TABS_ACTIONS = new Set(["list"]);
