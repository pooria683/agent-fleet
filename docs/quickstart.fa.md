# راهنمای سریع agent-fleet

این نسخهٔ MVP یک workbench محلی برای اجرای موازی coding agentهاست. هر agent در worktree و شاخهٔ جدا اجرا می‌شود؛ خروجی، لاگ، تست و diff آن ثبت می‌شود و هیچ خروجی‌ای خودکار merge نمی‌شود.

## نصب و دموی بدون کلید API

نیازمندی‌ها: Node.js 22.12 یا جدیدتر، Git 2.39 یا جدیدتر، macOS یا Linux (روی Windows از WSL استفاده کنید).

```sh
git clone https://github.com/pooria683/agent-fleet.git
cd agent-fleet
npm ci
npm run build
npm link
npm run demo
```

دمو از agentهای نمایشی قطعی استفاده می‌کند، نه مدل هوش مصنوعی؛ اما worktree، تغییر فایل، تست، lint، گزارش و diff همگی واقعی‌اند. هیچ هزینهٔ مدل یا اتصال شبکهٔ مدل لازم ندارد.

## اجرای واقعی

Claude Code یا Codex را جداگانه نصب و authenticate کنید. خود agent-fleet کلید API نمی‌گیرد، ولی CLIهای واقعی ممکن است به احراز هویت و شبکه نیاز داشته باشند.

```sh
agent-fleet agents --repo .
agent-fleet init --repo .
agent-fleet run --repo . --task "Implement password reset flow" \
  --agents claude,codex --parallel 2 --dry-run
```

اگر فرمان‌ها درست بودند، `--dry-run` را حذف کنید. فرمان `init` یک فایل جدید و untracked می‌سازد؛ پیش از اجرا آن را بررسی و commit کنید یا آگاهانه از `--allow-dirty` استفاده کنید. مخزن باید تمیز باشد؛ گزینهٔ `--allow-dirty` فقط اجازهٔ شروع می‌دهد و تغییرات commit‌نشدهٔ کد را وارد worktree نمی‌کند.

## مشاهده و مقایسه

در داشبورد با کلیدهای چپ/راست agent را انتخاب کنید؛ `d` برای diff، `l` برای لاگ، `t` برای ابزارها، `c` برای تست‌ها و `m` برای دستور merge است. `q` یا Ctrl+C اجرای زنده را متوقف می‌کند و لاگ‌ها و worktreeها باقی می‌مانند.

```sh
agent-fleet runs
agent-fleet show <run-id> --tui
agent-fleet report <run-id> --stdout
agent-fleet diff <run-id> claude
agent-fleet logs <run-id> claude --stream all
```

گزارش در `.agent-fleet/runs/<run-id>/report.md` ذخیره می‌شود. پیشرفت تقریبی است. هزینهٔ `—` یعنی نامعلوم، نه رایگان. امتیاز فقط یک heuristic برای غربالگری است و درستی کد را تضمین نمی‌کند.

## انتخاب و merge

ابتدا diff و تست‌ها را بررسی کنید، شاخهٔ مقصد را خودتان checkout کنید و مطمئن شوید تمیز است:

```sh
git switch main
agent-fleet merge <run-id> claude --into main --dry-run
agent-fleet merge <run-id> claude --into main
```

فرمان merge تأیید می‌گیرد، conflict را پیش‌بینی می‌کند و چیزی را push نمی‌کند. worktree جایگزین sandbox امنیتی نیست؛ agent و تست‌ها با دسترسی حساب شما اجرا می‌شوند. جزئیات در [Safety](safety.md) آمده است.
