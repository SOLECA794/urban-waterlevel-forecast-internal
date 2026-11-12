// Package webembed 嵌入构建后的前端静态资源（vite build 输出复制到本目录 web/ 下）。
package webembed

import "embed"

//go:embed all:web
var FS embed.FS
