/**
 * Core tools: status, target inspection, raw evaluation, and command execution.
 *
 * This module is the reference for how every other tool module is written — declare
 * the toolset and capability, let the registry wrap errors, and return structured
 * JSON alongside prose so agents never have to parse text.
 */
import type { ServerContext } from "../server.js";
export declare function registerCoreTools(ctx: ServerContext): void;
