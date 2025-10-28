import React, { useState } from 'react';
import { Plus, X, ChevronDown, AlertCircle } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { MODEL_METADATA, GROUPED_MODELS, PROVIDER_DISPLAY_NAMES } from '../../features/models';
import { cn } from '../utils';

const NewModelSelector = ({ selectedModels = [], onChange, availableModels = [], isModelAvailable }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  
  // Handle model selection/deselection
  const handleModelToggle = (modelId) => {
    // Only allow selection if model is available in backend
    if (!isModelAvailable?.(modelId)) {
      console.warn(`Model ${modelId} is not available in backend`);
      return;
    }
    
    const updatedModels = selectedModels.includes(modelId)
      ? selectedModels.filter(id => id !== modelId)
      : [...selectedModels, modelId];
    
    onChange(updatedModels);
  };

  // Get button text
  const getButtonText = () => {
    if (selectedModels.length === 0) {
      return "add models";
    }
    
    if (selectedModels.length === 1) {
      const model = MODEL_METADATA[selectedModels[0]];
      return model ? model.name : selectedModels[0];
    }
    
    return `${selectedModels.length} models`;
  };

  // Filter models to only show available ones
  const getFilteredModels = () => {
    const filtered = {};
    Object.entries(GROUPED_MODELS).forEach(([providerId, models]) => {
      const availableInProvider = models.filter(model => 
        availableModels.length === 0 || isModelAvailable?.(model.id)
      );
      if (availableInProvider.length > 0) {
        filtered[providerId] = availableInProvider;
      }
    });
    return filtered;
  };

  const filteredModels = getFilteredModels();
  
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsModalOpen(true)}
        className="h-8 px-3 text-black dark:text-white bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white font-mono font-medium shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150 rounded-full"
      >
        <Plus className="w-3 h-3 mr-1" />
        {getButtonText()}
        <ChevronDown className="w-3 h-3 ml-1" />
      </Button>
      
      {/* Model selection modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div 
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setIsModalOpen(false)}
          />
          
          {/* Modal */}
          <div className="relative bg-white dark:bg-gray-900 border-3 border-black dark:border-white shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] dark:shadow-[8px_8px_0px_0px_rgba(255,255,255,1)] rounded-lg max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-black dark:border-gray-600 flex items-center justify-between">
              <h2 className="text-lg font-bold text-black dark:text-white font-mono">
                Select Models
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsModalOpen(false)}
                className="text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
            
            {/* Content */}
            <div className="p-4 overflow-y-auto max-h-[60vh] hide-scrollbar">
              {Object.keys(filteredModels).length === 0 ? (
                <div className="text-center py-8">
                  <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-gray-600 dark:text-gray-400 font-mono">
                    No models available. Please check your backend connection.
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  {Object.entries(filteredModels).map(([providerId, models]) => (
                    <div key={providerId}>
                      <h3 className="text-md font-semibold text-black dark:text-white mb-3 font-mono">
                        {PROVIDER_DISPLAY_NAMES[providerId]}
                        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                          ({models.length} available)
                        </span>
                      </h3>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {models.map((model) => {
                          const isAvailable = isModelAvailable?.(model.id) ?? true;
                          const isSelected = selectedModels.includes(model.id);
                          
                          return (
                            <div
                              key={model.id}
                              onClick={() => handleModelToggle(model.id)}
                              className={cn(
                                "p-4 border-3 border-black dark:border-white rounded-lg transition-all duration-150",
                                isAvailable 
                                  ? "cursor-pointer bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600" 
                                  : "cursor-not-allowed bg-gray-100 dark:bg-gray-800 opacity-50",
                                "shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)]",
                                isAvailable && "hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)]",
                                isAvailable && "active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)]",
                                isAvailable && "active:translate-x-0.5 active:translate-y-0.5",
                                isSelected && isAvailable && "bg-blue-200 dark:bg-blue-800 border-blue-500 dark:border-blue-400"
                              )}
                            >
                              <div className="flex justify-between items-start mb-2">
                                <div className="flex items-center gap-3 flex-1">
                                  {model.icon && (
                                    <img 
                                      src={model.icon} 
                                      alt={model.provider} 
                                      className="w-6 h-6 object-contain"
                                    />
                                  )}
                                  <div className="flex-1">
                                    <div className="text-black dark:text-white font-medium text-sm font-mono flex items-center gap-2">
                                      {model.name}
                                      {!isAvailable && (
                                        <AlertCircle className="w-3 h-3 text-red-500" />
                                      )}
                                    </div>
                                    <div className="text-gray-600 dark:text-gray-400 text-xs font-mono">
                                      {isAvailable ? model.description : "Not available in backend"}
                                    </div>
                                  </div>
                                </div>
                                
                                {/* Checkbox indicator */}
                                <div className={cn(
                                  "w-5 h-5 border-2 border-black dark:border-white rounded flex items-center justify-center",
                                  isSelected && isAvailable && "bg-black dark:bg-white"
                                )}>
                                  {isSelected && isAvailable && (
                                    <div className="w-2 h-2 bg-white dark:bg-black rounded-sm" />
                                  )}
                                </div>
                              </div>
                              
                              {/* Selection indicator bar */}
                              {isSelected && isAvailable && (
                                <div className="w-full h-1 bg-black dark:bg-white rounded" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            {/* Footer */}
            <div className="p-4 border-t border-black dark:border-gray-600 flex items-center justify-between">
              <div className="text-sm text-gray-600 dark:text-gray-400 font-mono">
                {selectedModels.length} model{selectedModels.length !== 1 ? 's' : ''} selected
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsModalOpen(false)}
                  className="text-black dark:text-white bg-gray-200 dark:bg-gray-700 border-3 border-black dark:border-white font-mono font-medium shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] dark:shadow-[3px_3px_0px_0px_rgba(255,255,255,1)] hover:shadow-[1px_1px_0px_0px_rgba(0,0,0,1)] dark:hover:shadow-[1px_1px_0px_0px_rgba(255,255,255,1)] active:shadow-[0px_0px_0px_0px_rgba(0,0,0,1)] dark:active:shadow-[0px_0px_0px_0px_rgba(255,255,255,1)] active:translate-x-1 active:translate-y-1 transition-all duration-150"
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default NewModelSelector; 