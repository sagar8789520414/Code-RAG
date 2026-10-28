import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { EmptyState } from "./components/ui";
import { BenchmarksPage } from "./pages/BenchmarksPage";
import { ChatPage } from "./pages/ChatPage";
import { RepoDetailPage } from "./pages/RepoDetailPage";
import { ReposPage } from "./pages/ReposPage";
import { SearchPage } from "./pages/SearchPage";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ChatPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="repos" element={<ReposPage />} />
        <Route path="repos/:id" element={<RepoDetailPage />} />
        <Route path="benchmarks" element={<BenchmarksPage />} />
        <Route path="*" element={<EmptyState title="Page not found" />} />
      </Route>
    </Routes>
  );
}
