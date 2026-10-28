UUID = dynamic-notch@local
EXTENSION_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC_DIR = src
SCHEMAS_DIR = $(SRC_DIR)/schemas

.PHONY: install uninstall

install:
	@echo "Installing Dynamic Notch extension..."
	@mkdir -p $(EXTENSION_DIR)
	@cp -r $(SRC_DIR)/* $(EXTENSION_DIR)/
	@echo "Compiling GSettings schemas..."
	@glib-compile-schemas $(EXTENSION_DIR)/schemas
	@echo "Extension installed to $(EXTENSION_DIR)"
	@echo "Enable and reload the extension using GNOME Extensions app or:"
	@echo "  gnome-extensions enable $(UUID)"
	@echo "  gnome-extensions reload $(UUID)"

uninstall:
	@echo "Uninstalling Dynamic Notch extension..."
	@if [ -d "$(EXTENSION_DIR)" ]; then \
		rm -rf $(EXTENSION_DIR); \
		echo "Extension uninstalled from $(EXTENSION_DIR)"; \
	else \
		echo "Extension not found at $(EXTENSION_DIR)"; \
	fi

compile-schema:
	@echo "Compiling GSettings schemas..."
	@glib-compile-schemas $(SCHEMAS_DIR)
