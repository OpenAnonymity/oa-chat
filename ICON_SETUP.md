# Provider Icons Setup Guide

## Adding Provider Icons

The system now supports both inline SVG and image URLs. You can easily add icons by editing `services/providerIcons.js`.

### Method 1: Using Image URLs (Recommended)

This is the easiest way to add icons. You can use icons from online sources or downloaded files.

```javascript
// In services/providerIcons.js, add to PROVIDER_ICONS object:

'Anthropic': {
    type: 'url',
    url: 'https://www.anthropic.com/images/icons/anthropic-icon.png'
},

'Google': {
    type: 'url',
    url: 'https://www.google.com/favicon.ico'
},

'Meta': {
    type: 'url',
    url: '/img/meta-icon.png'  // Local file in chat/img/ folder
}
```

### Method 2: Using Inline SVG

If you have SVG code, you can embed it directly:

```javascript
'Mistral': {
    type: 'svg',
    data: '<path d="M12 2L2 7v10l10 5 10-5V7L12 2z"/>'
}
```

### Where to Find Icons

1. **Official Website Favicons**: Most companies have favicons you can use
   - Example: `https://www.anthropic.com/favicon.ico`

2. **Simple Icons**: Free SVG icons for popular brands
   - Website: https://simpleicons.org/
   - GitHub: https://github.com/simple-icons/simple-icons

3. **Download and Host Locally**:
   - Download icon images
   - Place in `chat/img/` folder
   - Reference as `/img/icon-name.png`

### Example Setup

Here's a complete example for adding Anthropic, Google, and Meta icons:

```javascript
const PROVIDER_ICONS = {
    'OpenAI': {
        type: 'svg',
        data: '<path d="M22.282 9.821a5.985..." />'
    },

    'Anthropic': {
        type: 'url',
        url: 'https://www.anthropic.com/favicon.ico'
    },

    'Google': {
        type: 'url',
        url: 'https://www.google.com/favicon.ico'
    },

    'Meta': {
        type: 'url',
        url: '/img/meta-icon.png'
    },

    'Mistral': {
        type: 'url',
        url: 'https://mistral.ai/favicon.ico'
    }
};
```

### Testing

After adding icons, refresh your browser with `Cmd/Ctrl + Shift + R` to clear the cache and see the changes.

## Current Limitations

- Image URLs must be publicly accessible or served from your local server
- SVG icons should be simple and render well at small sizes (24x24px)
- Icons are displayed at 14x14px (w-3.5 h-3.5 in Tailwind)

## Troubleshooting

If icons don't show:
1. Check browser console for 404 errors
2. Verify the URL is correct and publicly accessible
3. For local files, ensure they're in the `chat/` directory
4. Hard refresh browser: `Cmd/Ctrl + Shift + R`

