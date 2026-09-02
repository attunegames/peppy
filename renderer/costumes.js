// Melee costume table: for every character, the costumes in the order the game
// stores them (index 0 is the one you start on). The index is what Peppy writes
// into the character-select memory, so this order has to match the game's.
//
// Each entry is [name, swatch] - the swatch is a representative colour so the
// picker shows the costume instead of a number.
window.COSTUMES = {
  DOC:          [["White", "#e8e8e8"], ["Red", "#c8302c"], ["Blue", "#3350b8"], ["Green", "#3f9b46"], ["Black", "#2b2b2b"]],
  MARIO:        [["Red", "#d63b2f"], ["Yellow", "#e0c020"], ["Black", "#3a3a3a"], ["Blue", "#2f52c8"], ["Green", "#3fa04a"]],
  LUIGI:        [["Green", "#35a04a"], ["White", "#e6e6e6"], ["Blue", "#3a5cc0"], ["Pink", "#d76ea0"]],
  BOWSER:       [["Green", "#4a8a3a"], ["Red", "#c33a2f"], ["Blue", "#3555b5"], ["Black", "#333333"]],
  PEACH:        [["Pink", "#f2a6c4"], ["Daisy", "#e8d24a"], ["White", "#efefef"], ["Blue", "#5a7fd6"], ["Green", "#58b05c"]],
  YOSHI:        [["Green", "#5cba4a"], ["Red", "#d34437"], ["Blue", "#3a63c8"], ["Yellow", "#e5cc3f"], ["Pink", "#ea86b8"], ["Cyan", "#62c7d8"]],
  DK:           [["Brown", "#8a5a2b"], ["Black", "#3a3a3a"], ["Red", "#c33a2f"], ["Blue", "#3555b5"], ["Green", "#4a9b4a"]],
  CPTFALCON:    [["Indigo", "#4a4276"], ["Black", "#2f2f2f"], ["Red", "#c4372f"], ["White", "#e4e4e4"], ["Green", "#4a9b52"], ["Blue", "#3a63c8"]],
  GANONDORF:    [["Brown", "#6b5a3a"], ["Red", "#b1362f"], ["Blue", "#3a55a8"], ["Green", "#4a8a4a"], ["Lavender", "#a08ac4"]],
  FALCO:        [["Default", "#8b8f5a"], ["Red", "#d0453c"], ["Blue", "#4a6fd0"], ["Green", "#4f9b4e"]],
  FOX:          [["Default", "#cbb27c"], ["Orange", "#d4622e"], ["Lavender", "#7b7ad0"], ["Green", "#4f9b4e"]],
  NESS:         [["Default", "#e0554a"], ["Yellow", "#e5c73f"], ["Blue", "#4064c8"], ["Green", "#4fa055"]],
  POPO:         [["Blue", "#4f7bd6"], ["Green", "#4fa85c"], ["Orange", "#e08a34"], ["Red", "#cf4038"]],
  KIRBY:        [["Pink", "#f09ac0"], ["Yellow", "#ecd44a"], ["Blue", "#5a7fd6"], ["Red", "#d3423a"], ["Green", "#52b05a"], ["White", "#efefef"]],
  SAMUS:        [["Orange", "#e07a2a"], ["Pink", "#ef8fb8"], ["Black", "#3a3a3a"], ["Green", "#4f9b52"], ["Purple", "#8a5ec0"]],
  ZELDA:        [["Default", "#e9c3d2"], ["Red", "#c9403e"], ["Blue", "#3f5cc0"], ["Green", "#4c9a52"], ["White", "#f2f2f2"]],
  SHEIK:        [["Default", "#e9c3d2"], ["Red", "#c9403e"], ["Blue", "#3f5cc0"], ["Green", "#4c9a52"], ["White", "#f2f2f2"]],
  LINK:         [["Green", "#3f9b46"], ["Red", "#c53a30"], ["Blue", "#3a5cc4"], ["Black", "#333333"], ["White", "#ececec"]],
  YLINK:        [["Green", "#4aa551"], ["Red", "#c53a30"], ["Blue", "#3a5cc4"], ["White", "#ececec"], ["Black", "#333333"]],
  PICHU:        [["Default", "#f2d84a"], ["Red", "#cf4038"], ["Blue", "#3f63c8"], ["Green", "#4fa055"]],
  PIKACHU:      [["Default", "#f2d84a"], ["Red", "#cf4038"], ["Blue", "#3f63c8"], ["Green", "#4fa055"]],
  JIGGLYPUFF:   [["Default", "#f6c8dc"], ["Flower", "#d24a52"], ["Bow", "#4f74cc"], ["Headband", "#52a45a"], ["Crown", "#e8cf50"]],
  MEWTWO:       [["Default", "#cdb8cf"], ["Red", "#c4453f"], ["Blue", "#4360c0"], ["Green", "#4f9b52"]],
  GAMEANDWATCH: [["Black", "#2b2b2b"], ["Red", "#c33a2f"], ["Blue", "#3555b5"], ["Green", "#45994c"]],
  MARTH:        [["Blue", "#3d5fc0"], ["Red", "#c33f3a"], ["Green", "#4b9b52"], ["Black", "#333333"], ["White", "#ededed"]],
  ROY:          [["Purple", "#7a4fa8"], ["Red", "#c33f3a"], ["Blue", "#3f5cc4"], ["Green", "#4b9b52"], ["Yellow", "#e0c34a"]],
};

// Anything Peppy doesn't know gets the plain default-only list, so the picker
// never disappears on an unexpected name.
window.costumesFor = function costumesFor(character) {
  return window.COSTUMES[String(character || "").toUpperCase()] || [["Default", "#8b98a5"]];
};
