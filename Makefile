.PHONY: help install test test-watch build verify check pack preflight bump release-npm release-gh clean

VERSION := $(shell node -p "require('./package.json').version")

# Default target
help:
	@echo ""
	@echo "  domma-reactive $(VERSION) — Available commands"
	@echo ""
	@echo "  Development"
	@echo "    make install      Install dependencies"
	@echo "    make test         Run the suite once"
	@echo "    make test-watch   Run the suite in watch mode"
	@echo "    make build        Build dist/ (UMD, CJS, ESM)"
	@echo "    make verify       Build, then check the packaged artefacts"
	@echo "    make check        test + verify"
	@echo "    make pack         Create a tarball for local testing (no publish)"
	@echo "    make clean        Remove dist/ and any stray tarball"
	@echo ""
	@echo "  Release  (in this order)"
	@echo "    make bump V=X.Y.Z Set the version in package.json + package-lock.json"
	@echo "    <CHANGELOG.md>    Add a '## [X.Y.Z] - YYYY-MM-DD' entry at the top"
	@echo "    git commit        Commit the bump and the entry together"
	@echo "    make preflight    Clean, not behind origin, unreleased, noted, green"
	@echo "    make release-npm  Publish to npm"
	@echo "    make release-gh   Push main, tag vX.Y.Z, push the tag"
	@echo ""
	@echo "    preflight runs AFTER the bump is committed — it checks the version"
	@echo "    you are about to publish, not the one you last published."
	@echo ""
	@echo "  Domma pins this package EXACTLY. After releasing, re-pin it there:"
	@echo "    cd ../domma && npm install domma-reactive@X.Y.Z --save-exact && npm run build:js"
	@echo ""

# ── Development ──────────────────────────────────────────────────────────────

install:
	npm install

test:
	npm run test:run

test-watch:
	npm test

build:
	npm run build

# The one that matters before a publish. Builds, then loads every declared
# entry point the way a real consumer would — require(), import() and a browser
# <script> — checks no bundle contains dynamic code construction (what lets
# bindings run under script-src 'self'), and asserts every artefact is stamped
# with the current version, so a stale dist/ cannot be published as a fresh one.
verify:
	npm run test:dist

check: test verify

pack:
	npm run build
	npm pack
	@echo ""
	@echo "  Tarball created. Test it against a real consumer with:"
	@echo "    cd ../domma && npm install ../domma-reactive/domma-reactive-$(VERSION).tgz"
	@echo ""

clean:
	rm -rf dist/
	rm -f domma-reactive-*.tgz

# ── Release ──────────────────────────────────────────────────────────────────

# Everything that is cheaper to find out now than after publishing. npm will
# not let you republish or reuse a version number, so a bad publish is
# permanent — it can only be deprecated and superseded.
preflight:
	@git diff --quiet && git diff --cached --quiet \
		|| { echo ""; echo "  preflight: working tree is dirty — commit or stash first"; echo ""; exit 1; }
	@git fetch --quiet origin
	@git merge-base --is-ancestor origin/main HEAD \
		|| { echo ""; echo "  preflight: HEAD is BEHIND origin/main — fast-forward before releasing"; \
		     echo "  local  $$(git rev-parse --short HEAD)"; \
		     echo "  remote $$(git rev-parse --short origin/main)"; echo ""; \
		     echo "  Releasing from a stale base is how a real tag gets clobbered."; echo ""; exit 1; }
	@git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null \
		&& { echo ""; echo "  preflight: tag v$(VERSION) already exists — bump the version first"; echo ""; exit 1; } \
		|| true
	@npm view domma-reactive@$(VERSION) version >/dev/null 2>&1 \
		&& { echo ""; echo "  preflight: $(VERSION) is already published — npm will refuse it"; echo ""; exit 1; } \
		|| true
	@grep -q "^## \[$(VERSION)\]" CHANGELOG.md \
		|| { echo ""; echo "  preflight: no '## [$(VERSION)]' entry in CHANGELOG.md"; echo ""; exit 1; }
	$(MAKE) verify
	@echo ""
	@echo "  preflight: clean, not behind origin, $(VERSION) unpublished, artefacts verified"
	@echo ""

# Deliberately does NOT commit. The version bump belongs in a commit whose
# message says what the release contains, and that is not something a Makefile
# can write.
bump:
	@test -n "$(V)" || { echo ""; echo "  usage: make bump V=X.Y.Z"; echo ""; exit 1; }
	node scripts/bump.mjs $(V)
	@echo "  Now commit it, e.g.:"
	@echo "    git add package.json package-lock.json && git commit"
	@echo ""

# prepublishOnly re-runs the suite and the artefact check, so this cannot
# publish a bundle that was not built from the code being published.
release-npm:
	npm publish

# Tag AFTER publishing, so a failed publish does not leave a tag pointing at a
# version that does not exist on npm.
release-gh:
	git push origin main
	git tag -a v$(VERSION) -m "domma-reactive $(VERSION)"
	git push origin v$(VERSION)
	@echo ""
	@echo "  Tagged and pushed v$(VERSION)."
	@echo "  This repo publishes via npm and tags only — no GitHub release object."
	@echo "  If you want one:  gh release create v$(VERSION) --generate-notes"
	@echo ""
