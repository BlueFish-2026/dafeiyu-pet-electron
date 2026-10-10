/**
 * 应用版本号 —— 内置自动更新的唯一真源。
 *
 * 发新版时改这里，并同步更新仓库根的 `version.json`（用 `_dsh_probe/gen_version_json.py` 生成，
 * 它会读取本文件的 APP_VERSION 并列出需要同步的文件清单）。
 *
 * 语义化：v主.次.补
 *   主 = 大改 / 不兼容（换引擎、换素材结构）
 *   次 = 加功能
 *   补 = 修 bug
 */
export const APP_VERSION = '1.2.0';
