UUID = dynamic-notch@faishalmhmd
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR = src
SCHEMAS_DIR = $(SRC_DIR)/schemas
DIST_DIR = dist

DEFAULT_FILES = extension.js metadata.json stylesheet.css prefs.js schemas
EXTRA_SOURCES = $(filter-out $(DEFAULT_FILES),$(notdir $(wildcard $(SRC_DIR)/*)))

.PHONY: install uninstall compile-schema debug pack

install:
	@echo "Installing Dynamic Notch..."
	@mkdir -p $(EXTENSION_DIR)
	@cp -r $(SRC_DIR)/* $(EXTENSION_DIR)/
	@glib-compile-schemas $(EXTENSION_DIR)/schemas
	@echo "Installed to $(EXTENSION_DIR)"

compile-schema:
	@glib-compile-schemas $(SCHEMAS_DIR)

pack:
	@mkdir -p $(DIST_DIR)
	@cd $(SRC_DIR) && gnome-extensions pack --force --out-dir=../$(DIST_DIR) \
		$(foreach f,$(EXTRA_SOURCES),--extra-source=$(f)) .
	@echo "Packed:"
	@unzip -l $(DIST_DIR)/$(UUID).shell-extension.zip

debug: install
	@echo "Starting nested GNOME Shell 51..."
	@dbus-run-session -- sh -c '\
		export SHELL_DEBUG=backtrace-warnings; \
		gnome-shell --devkit --wayland & \
		shell_pid=$$!; \
		trap "kill $$shell_pid 2>/dev/null || true" EXIT INT TERM; \
		sleep 5; \
		gnome-extensions enable $(UUID); \
		wait $$shell_pid'

uninstall:
	@echo "Uninstalling Dynamic Notch..."
	@rm -rf $(EXTENSION_DIR)
	@echo "Uninstalled."
