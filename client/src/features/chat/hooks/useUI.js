import { useState, useEffect } from 'react';

/**
 * Custom hook for UI state management
 * Handles responsive design, panels, and UI interactions
 */
export const useUI = () => {
  const [showThemeToggle, setShowThemeToggle] = useState(false);
  const [isRightPanelVisible, setIsRightPanelVisible] = useState(true);
  const [leftPanelWidth, setLeftPanelWidth] = useState(70);
  const [isMobile, setIsMobile] = useState(false);
  const [showMobileControls, setShowMobileControls] = useState(false);

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    
    checkMobile();
    window.addEventListener('resize', checkMobile);
    
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Handle mouse movement for theme toggle
  const handleMouseMove = (e) => {
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    if (e.clientX > windowWidth - 100 && e.clientY > windowHeight - 100) {
      setShowThemeToggle(true);
    } else {
      setShowThemeToggle(false);
    }
  };

  // Panel controls
  const toggleRightPanel = () => {
    setIsRightPanelVisible(!isRightPanelVisible);
  };

  const handlePanelResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftPanelWidth;
    
    const handleMouseMove = (e) => {
      e.preventDefault();
      const deltaX = e.clientX - startX;
      const containerWidth = window.innerWidth;
      const newWidth = startWidth + (deltaX / containerWidth) * 100;
      setLeftPanelWidth(Math.max(20, Math.min(85, newWidth)));
    };
    
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return {
    // State
    showThemeToggle,
    isRightPanelVisible,
    leftPanelWidth,
    isMobile,
    showMobileControls,

    // Setters
    setShowMobileControls,
    setLeftPanelWidth,

    // Actions
    handleMouseMove,
    toggleRightPanel,
    handlePanelResize
  };
};