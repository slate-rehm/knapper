/**
 * Curated @playwright/mcp tools exposed through the `ui` toolset.
 *
 * This is an allowlist, not a blocklist: only names here are registered even when
 * the upstream server advertises more (storage, navigation, close, etc.).
 */

/** Tools that must never be forwarded even if they appear in listTools(). */
export const BLOCKED_BROWSER_TOOLS = new Set([
  "browser_close",
  "browser_console_messages",
  "browser_evaluate",
  "browser_find",
  "browser_generate_locator",
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
  "browser_tabs",
  "browser_verify_element_visible",
  "browser_verify_list_visible",
  "browser_verify_text_visible",
  "browser_verify_value",
]);

/**
 * Core interaction surface with `vision` + `testing` capabilities enabled upstream.
 * Arbitrary evaluation and the redundant discovery/assertion tools stay private.
 * Their output can include data from every page in the shared browser context.
 */
export const ALLOWED_BROWSER_TOOLS = new Set([
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
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_type",
  "browser_wait_for",
]);

export function isAllowedBrowserTool(name: string): boolean {
  return ALLOWED_BROWSER_TOOLS.has(name) && !BLOCKED_BROWSER_TOOLS.has(name);
}

/**
 * Proxied tools that deliver real mouse or keyboard input.
 *
 * `FocusEmulator` wraps these tools so input lands when Obsidian is not the
 * foreground window. The proxy fences and targets every tool, including reads.
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
