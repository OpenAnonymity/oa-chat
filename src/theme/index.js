import { extendTheme } from '@chakra-ui/react';

// Common scrollbar styles
const scrollbarStyles = {
  '&': {
    scrollbarWidth: 'thin',
    scrollbarColor: 'transparent transparent',
  },
  '&:hover': {
    scrollbarColor: 'rgba(255, 255, 255, 0.3) transparent',
  },
  '&::-webkit-scrollbar': {
    width: '6px',
  },
  '&::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '&::-webkit-scrollbar-thumb': {
    background: 'transparent',
    borderRadius: '10px',
  },
  '&:hover::-webkit-scrollbar-thumb': {
    background: 'rgba(255, 255, 255, 0.3)',
  },
  '&::-webkit-scrollbar-thumb:hover': {
    background: 'rgba(255, 255, 255, 0.5)',
  },
};

// Color palette
const colors = {
  primary: {
    bg: '#2f3436',
    surface: '#404749',
    text: '#f5f5f5',
    accent: 'teal.500',
    border: 'gray.600',
  },
};

const theme = extendTheme({
  fonts: {
    heading: "'Roboto Mono', monospace",
    body: "'Roboto Mono', monospace",
  },
  styles: {
    global: {
      html: {
        backgroundColor: colors.primary.bg,
        height: '100%',
      },
      body: {
        color: colors.primary.text,
        bg: colors.primary.bg,
        minHeight: '100vh',
        margin: 0,
        padding: 0,
      },
      '#root': {
        minHeight: '100vh',
        backgroundColor: colors.primary.bg,
      },
      a: {
        color: colors.primary.accent,
        _hover: {
          textDecoration: 'underline',
        },
      },
    },
  },
  components: {
    Button: {
      baseStyle: {
        fontFamily: "'Roboto Mono', monospace",
      },
      variants: {
        outline: {
          borderColor: colors.primary.border,
          color: colors.primary.text,
          _hover: {
            bg: 'gray.700',
          },
        },
      },
    },
    Heading: {
      baseStyle: {
        fontFamily: "'Roboto Mono', monospace",
        color: colors.primary.text,
      },
    },
    Text: {
      baseStyle: {
        fontFamily: "'Roboto Mono', monospace",
      },
    },
    Input: {
      baseStyle: {
        bg: colors.primary.bg,
        color: colors.primary.text,
        borderColor: colors.primary.border,
      },
      defaultProps: {
        focusBorderColor: colors.primary.accent,
      },
    },
    IconButton: {
      baseStyle: {
        color: colors.primary.text,
      },
    },
  },
});

export { theme, scrollbarStyles, colors }; 