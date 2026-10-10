// Render the exported Go interface using the same go/doc model as godoc.
package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/doc"
	"go/doc/comment"
	"go/format"
	"go/parser"
	"go/token"
	"html"
	"os"
	"strings"
)

func main() {
	set := token.NewFileSet()
	packages, err := parser.ParseDir(set, "packages/go", func(info os.FileInfo) bool { return !strings.HasSuffix(info.Name(), "_test.go") }, parser.ParseComments)
	check(err)
	pkg := doc.New(packages["clyops"], "github.com/wankdanker/clyops/packages/go", 0)
	var output strings.Builder
	output.WriteString("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>clyops Go API</title><link rel=\"stylesheet\" href=\"../../assets/docs.css\"><main><a href=\"../../languages/go.html\">Go guide</a><h1>Go API</h1>")
	text := func(value string) {
		parser := comment.Parser{}
		printer := comment.Printer{}
		output.Write(printer.HTML(parser.Parse(value)))
	}
	item := func(name, description string, node ast.Node) {
		if description == "" {
			panic("undocumented Go export: " + name)
		}
		var source bytes.Buffer
		check(format.Node(&source, set, node))
		fmt.Fprintf(&output, "<section id=\"%s\"><h2>%s</h2><pre><code>%s</code></pre>", html.EscapeString(name), html.EscapeString(name), html.EscapeString(source.String()))
		text(description)
		output.WriteString("</section>")
	}
	text(pkg.Doc)
	for _, value := range append(pkg.Consts, pkg.Vars...) {
		item(strings.Join(value.Names, ", "), value.Doc, value.Decl)
	}
	for _, fn := range pkg.Funcs {
		item(fn.Name, fn.Doc, fn.Decl)
	}
	for _, typ := range pkg.Types {
		item(typ.Name, typ.Doc, typ.Decl)
		for _, fn := range typ.Funcs {
			item(fn.Name, fn.Doc, fn.Decl)
		}
		for _, method := range typ.Methods {
			item(typ.Name+"."+method.Name, method.Doc, method.Decl)
		}
	}
	output.WriteString("</main></html>")
	check(os.MkdirAll("docs/_native/go", 0755))
	check(os.WriteFile("docs/_native/go/index.html", []byte(output.String()), 0644))
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}
