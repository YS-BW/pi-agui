/**
 * npm install 会把 node_modules 里非声明的包清掉，包括我们软链进去的 pi。
 * 这个脚本负责把它接回来：优先用全局 npm 根目录里的 @earendil-works/pi-coding-agent，
 * 找不到再退回本机已知的全局安装路径。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");

function candidates() {
	const list = [];
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
		list.push(join(globalRoot, "@earendil-works", "pi-coding-agent"));
	} catch {
		// 没装 npm 就算了，走下面的兜底路径
	}
	list.push("/Users/lixinlv/.local/lib/node_modules/@earendil-works/pi-coding-agent");
	return list;
}

const source = candidates().find((path) => existsSync(join(path, "package.json")));

if (!source) {
	console.warn("[link-pi] 没找到全局安装的 @earendil-works/pi-coding-agent，跳过软链。");
	console.warn("[link-pi] 可以先跑：npm i -g @earendil-works/pi-coding-agent");
	process.exit(0);
}

if (existsSync(join(target, "package.json"))) {
	console.log(`[link-pi] 已存在，跳过：${target}`);
	process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
symlinkSync(source, target, "dir");
console.log(`[link-pi] 已软链 ${source} -> ${target}`);
