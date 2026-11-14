import { Fragment } from 'react'

/**
 * 极简强调标记：只认 `**加粗**`。
 *
 * 为什么要这个东西：文案里大量写着「**不能裁**」「**只降不升**」这种强调，
 * 那是 markdown 的写法。它写在注释里没问题，一旦写进**被渲染的字符串**
 * （讲解稿、错误说明、术语释义），`**` 会原样出现在屏幕上 ——
 * 在一个自称交付级的系统里，界面上飘着星号是很显眼的破绽。
 *
 * 只支持一种标记是刻意的：这里不是 markdown 渲染器，是文案排版。
 * 支持得越多，就越容易有人往文案里塞表格和链接，最后界面变成文档。
 */
export function Emph({ text, strong }: { text: string; strong?: React.CSSProperties }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
          return (
            <strong key={i} style={{ fontWeight: 600, ...strong }}>
              {p.slice(2, -2)}
            </strong>
          )
        }
        return <Fragment key={i}>{p}</Fragment>
      })}
    </>
  )
}
