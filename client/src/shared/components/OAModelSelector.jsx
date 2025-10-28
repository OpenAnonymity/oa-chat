import React, { useState, useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { openRouterClient } from '../services';

/**
 * OA Model Selector Component
 * Simplified dropdown for selecting models
 */
export const OAModelSelector = ({ value, onChange, disabled }) => {
  const [models, setModels] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchModels = async () => {
      try {
        setIsLoading(true);
        const modelList = await openRouterClient.getModels();
        
        // Filter for popular/recommended models to avoid overwhelming users
        const popularModels = modelList.filter(model => 
          model.id.includes('gpt') || 
          model.id.includes('claude') || 
          model.id.includes('gemini') ||
          model.id.includes('mistral') ||
          model.id.includes('llama')
        ).slice(0, 20); // Limit to 20 models
        
        setModels(popularModels.length > 0 ? popularModels : modelList.slice(0, 20));
        
        // Set default model if none selected
        if (!value && popularModels.length > 0) {
          onChange(popularModels[0].id);
        }
      } catch (err) {
        console.error('Error fetching models:', err);
        setError(err.message);
        
        // Fallback to common models if API call fails
        const fallbackModels = [
          { id: 'openai/gpt-4o', name: 'GPT-4o' },
          { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
          { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
          { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus' },
          { id: 'google/gemini-pro', name: 'Gemini Pro' },
        ];
        setModels(fallbackModels);
        
        if (!value) {
          onChange(fallbackModels[0].id);
        }
      } finally {
        setIsLoading(false);
      }
    };

    fetchModels();
  }, []);

  const getModelDisplayName = (model) => {
    if (typeof model === 'string') return model;
    return model.name || model.id || 'Unknown Model';
  };

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled || isLoading}>
      <SelectTrigger className="bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white text-black dark:text-white font-mono font-medium shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 transition-shadow">
        <SelectValue>
          {isLoading ? 'Loading models...' : (value || 'Select a model')}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white text-black dark:text-white font-mono shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] dark:shadow-[4px_4px_0px_0px_rgba(255,255,255,1)]">
        {error && (
          <div className="p-2 text-xs text-red-600 dark:text-red-400">
            Using fallback models
          </div>
        )}
        {models.map((model) => (
          <SelectItem
            key={typeof model === 'string' ? model : model.id}
            value={typeof model === 'string' ? model : model.id}
            className="font-mono text-sm hover:bg-gray-100 dark:hover:bg-gray-600 focus:bg-gray-100 dark:focus:bg-gray-600"
          >
            {getModelDisplayName(model)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

