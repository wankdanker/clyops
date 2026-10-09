CC      ?= cc
CFLAGS  ?= -std=c11 -O2 -g -Wall -Wextra -Wpedantic -Werror
CPPFLAGS += -Iinclude
BUILD   ?= build

.PHONY: all test clean

all: $(BUILD)/libclyops.a $(BUILD)/demo $(BUILD)/tasks $(BUILD)/test_clyops

$(BUILD)/clyops.o: src/clyops.c include/clyops.h src/completions.h | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(BUILD)/libclyops.a: $(BUILD)/clyops.o
	$(AR) rcs $@ $^

$(BUILD)/demo: examples/demo.c $(BUILD)/libclyops.a
	$(CC) $(CPPFLAGS) $(CFLAGS) $< -L$(BUILD) -lclyops -o $@

$(BUILD)/tasks: examples/tasks.c $(BUILD)/libclyops.a
	$(CC) $(CPPFLAGS) $(CFLAGS) $< -L$(BUILD) -lclyops -o $@

$(BUILD)/test_clyops: tests/test_clyops.c $(BUILD)/libclyops.a
	$(CC) $(CPPFLAGS) $(CFLAGS) $< -L$(BUILD) -lclyops -o $@

$(BUILD):
	mkdir -p $@

test: all
	$(BUILD)/test_clyops

clean:
	rm -rf $(BUILD)
