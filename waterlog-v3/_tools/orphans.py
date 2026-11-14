"""列出没有任何文件 import 的源文件（删掉旧页面后找残留）。

判据刻意宽松：只要某个文件里出现 `from '.../stem'` 就算被引用，
包括 type-only import 与动态 import 的字符串形式。
不做 TS 语义分析——这里只需要「大概没人用了」的候选清单，
最终是否删除由 tsc 与打包结果裁定，不由这个脚本裁定。
"""

import io
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')


def collect():
    out = []
    for dirpath, _dirs, names in os.walk(os.path.join(ROOT, 'src')):
        for name in names:
            if name.endswith(('.ts', '.tsx')) and not name.endswith('.d.ts'):
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
                out.append((rel, io.open(full, encoding='utf-8').read()))
    return out


def main():
    files = collect()
    pats = {}
    for rel, text in files:
        stem = os.path.splitext(os.path.basename(rel))[0]
        pats.setdefault(stem, []).append((rel, text))

    orphans = []
    for rel, _text in files:
        if rel == 'src/main.tsx':
            continue
        stem = os.path.splitext(os.path.basename(rel))[0]
        used = False
        for other, text in files:
            if other == rel:
                continue
            if re.search(r'from\s+[\'"][^\'"]*/' + re.escape(stem) + r'[\'"]', text):
                used = True
                break
        if not used:
            orphans.append(rel)
    for o in sorted(orphans):
        print(o)
    print('--- 共 %d 个候选' % len(orphans), file=sys.stderr)


if __name__ == '__main__':
    main()
