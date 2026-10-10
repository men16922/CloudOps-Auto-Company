.DEFAULT_GOAL := check
ifneq ($(wildcard .tools/node/bin/node),)
export PATH := $(CURDIR)/.tools/node/bin:$(PATH)
endif
.PHONY: check build test dev
check:
	npm run check
build:
	npm run build
test:
	npm run test:server
dev:
	npm run dev
