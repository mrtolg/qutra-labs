# ADR 0009 - Retired block editor

**Status:** superseded by scope-simplification migration v12

The earlier product scope selected Lexical for a standalone knowledge editor.
That surface was retired during product simplification. Its source, tests and
package dependencies were removed.

Qutra Labs does not currently ship a generic document editor. Any future
structured editing requirement must be justified inside one of the nine product
modules and evaluated in a new ADR instead of reviving this decision implicitly.
