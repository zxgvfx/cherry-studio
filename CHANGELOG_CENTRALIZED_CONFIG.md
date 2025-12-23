# Cherry Studio - Centralized Config Feature

## Overview
This feature implements a centralized configuration management system. It allows administrators to define read-only models and providers via a JSON file, which are then merged with the user's local configuration. This feature is useful for enterprise deployment or managed environments.

## Key Changes

### 1. Centralized Configuration Loading (`web/src/renderer/src/hooks/useAppInit.ts`)
- **Action**: Modified `useAppInit` hook to fetch centralized config from the backend (`window.api.config.getMergedConfig`).
- **Logic**: 
  - Iterates through `centralizedModels`.
  - Dynamically creates a "Centralized" (or custom named) Provider if it doesn't exist.
  - Dispatches `addModel` and `updateModel` actions to Redux store.
  - Sets `isCentralized: true` flag on these models.
  - **Dynamic Grouping**: Models are grouped based on the provider name/ID defined in `centralized-config.json`, matching logic added to support custom group names.

### 2. Provider & Model Types (`web/src/renderer/src/types/`)
- **Action**: Updated `Model` and `Provider` interfaces.
- **Fields Added**:
  - `isCentralized?: boolean`: Marks models/providers as read-only.
  - `avatar?: string`: For models.
  - `icon?: string`: For providers (custom logos).

### 3. UI Customization
- **Icons (`web/src/renderer/src/components/ProviderAvatar.tsx`)**:
  - Updated `ProviderAvatar` to check for `provider.icon` field, enabling custom icons for the centralized provider without relying on hardcoded assets.
- **Model List**: 
  - Logic ensures centralized models appear in their specific group.

### 4. Persistence Filtering
- **Logic**: 
  - Ensures that read-only centralized configuration data is **not** duplicated into the user's permanent local storage file, keeping the user config clean.

## Usage
1.  **Config File**: Located at `resources/centralized-config.json` (or configured via environment variables).
2.  **Format**:
    ```json
    {
      "provider": {
        "id": "centralized",
        "name": "My Studio",
        "icon": "https://..."
      },
      "models": [ ... ]
    }
    ```

## Branch Information
- **Branch Name**: `feat/centralized-config`
- **Base**: `v1.7.6`
