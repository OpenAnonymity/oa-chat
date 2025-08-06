// Model metadata for display purposes
// This matches the backend's providers.yaml structure exactly
export const MODEL_METADATA = {
  // OpenAI models (matches backend exactly)
  'gpt-4o': {
    name: 'GPT-4o',
    description: 'OpenAI\'s latest and most capable model',
    icon: 'https://img.icons8.com/?size=100&id=Nts60kQIvGqe&format=png&color=000000',
    color: '#19c37d',
    provider: 'OpenAI'
  },
  'gpt-4o-mini': {
    name: 'GPT-4o Mini',
    description: 'Faster and more affordable GPT-4o',
    icon: 'https://img.icons8.com/?size=100&id=Nts60kQIvGqe&format=png&color=000000',
    color: '#19c37d',
    provider: 'OpenAI'
  },
  'o4-mini': {
    name: 'o4-mini',
    description: 'fatest reaoning model',
    icon: 'https://img.icons8.com/?size=100&id=Nts60kQIvGqe&format=png&color=000000',
    color: '#19c37d',
    provider: 'OpenAI'
  },
  'gpt-o1': {
    name: 'GPT-o1',
    description: 'Frontier model',
    icon: 'https://img.icons8.com/?size=100&id=Nts60kQIvGqe&format=png&color=000000',
    color: '#19c37d',
    provider: 'OpenAI'
  },
  
  // Anthropic models (matches backend exactly)
  'claude-3-haiku-20240307': {
    name: 'Claude 3 Haiku',
    description: 'Fastest Claude model for quick responses',
    icon: 'https://img.icons8.com/?size=100&id=YhbpKKuhwWAP&format=png&color=000000',
    color: '#b085ff',
    provider: 'Anthropic'
  },

  'claude-3-7-sonnet-20250219': {
    name: 'Claude 3.7 Sonnet',
    description: 'Fastest Claude model for quick responses',
    icon: 'https://img.icons8.com/?size=100&id=YhbpKKuhwWAP&format=png&color=000000',
    color: '#b085ff',
    provider: 'Anthropic'
  },
  
  // DeepSeek models (matches backend exactly)
  'deepseek-reasoner': {
    name: 'DeepSeek Reasoner',
    description: 'Advanced reasoning capabilities',
    icon: 'https://img.icons8.com/?size=100&id=BXsdQPYarISt&format=png&color=000000',
    color: '#4285f4',
    provider: 'DeepSeek'
  },
  'deepseek-chat': {
    name: 'DeepSeek Chat',
    description: 'General-purpose conversational AI',
    icon: 'https://img.icons8.com/?size=100&id=BXsdQPYarISt&format=png&color=000000',
    color: '#4285f4',
    provider: 'DeepSeek'
  },
  'deepseek-coder': {
    name: 'DeepSeek Coder',
    description: 'Specialized for coding and technical tasks',
    icon: 'https://img.icons8.com/?size=100&id=BXsdQPYarISt&format=png&color=000000',
    color: '#4285f4',
    provider: 'DeepSeek'
  },
  
  // XAI models (matches backend exactly)
  'grok-3-beta': {
    name: 'Grok 3',
    description: 'Latest XAI model with improved capabilities',
    icon: 'https://img.icons8.com/?size=100&id=SvMVhUPAeXkz&format=png&color=000000',
    color: '#000000',
    provider: 'XAI'
  },
  
  // Together models (matches backend exactly)
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': {
    name: 'Llama 3.1 8B Chat Turbo',
    description: 'Meta\'s open-source language model via Together',
    icon: 'https://img.icons8.com/?size=100&id=1rWM8zYmJ1ks&format=png&color=000000',
    color: '#1877f2',
    provider: 'Together'
  }
};

// Provider display names (matches backend provider names exactly)
export const PROVIDER_DISPLAY_NAMES = {
  'OpenAI': 'OpenAI',
  'Anthropic': 'Anthropic',
  'DeepSeek': 'DeepSeek',
  'XAI': 'xAI',
  'Together': 'Together',
  'Google': 'Google'
};

// Group models by provider for the UI
export const GROUPED_MODELS = Object.entries(MODEL_METADATA).reduce((acc, [modelId, metadata]) => {
  const provider = metadata.provider;
  if (!acc[provider]) {
    acc[provider] = [];
  }
  acc[provider].push({ id: modelId, ...metadata });
  return acc;
}, {});

